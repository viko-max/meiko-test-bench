/**
 * Import + question-bank service (Next_Plan §3/§6). Turns external material
 * (Markdown / TXT / JSON) into DRAFT questions staged under `.import/<draftId>/`
 * — NEVER touching the formal `datasets/` until explicitly confirmed. Confirming
 * serialises each draft question to the canonical `public/<id>.md` + independent
 * `scoring/<id>.json` (readable by importDataset), copies any referenced figures
 * from the source into public/ (originals preserved; shared figures deduped),
 * and records a version digest. Archiving retains the staged data; cancellation
 * and publication failures leave the formal bank untouched.
 *
 * Rules honoured (Next_Plan §3): original conditions/figures preserved verbatim;
 * provenance (source file) recorded per question; scoring kept SEPARATE from the
 * answering input (public/) and tool dirs; a question with no complete scoring
 * basis stays UNSCORED (collectable, not counted) and is never auto-guessed.
 *
 * Pure service layer — the TUI/Web drive it (AGENTS.md §3); reusable later.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, renameSync, realpathSync } from "node:fs";
import { join, dirname, resolve, basename, relative } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
import { ScoringSpecSchema, VersionSchema, PublicPartSchema, type ScoringSpec } from "../shared/contracts.js";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import { sha256OfJsonable, sha256OfBytes } from "../shared/hashing.js";
import { writeJsonAtomic } from "../shared/json.js";
import { parseOptionsFromBody, parseQuestionMarkdown } from "../dataset/parse.js";
import { checkDraft, scoringComplete, type ConvertCheck } from "./convert-check.js";
import { publicQuestion, scoringSpec, validateImportId } from "./validation.js";
import { resolvePublicAttachment, resolveWithin } from "../tools/paths.js";
import { importDataset } from "../dataset/import.js";
import { sha256OfText } from "../shared/hashing.js";
import { buildUserContent } from "../runner/prompt.js";

export type AnswerKind = "single_choice" | "multi_choice" | "numeric_unit" | "multi_blank" | "expression" | "open" | "out_of_scope";
const ANSWER_KINDS = new Set<string>(["single_choice", "multi_choice", "numeric_unit", "multi_blank", "expression", "open", "out_of_scope"]);

export type DraftScoring = Partial<Omit<ScoringSpec, "questionId" | "questionVersion" | "answerKind">>;

export interface DraftQuestion {
  id: string;
  version: string;
  subject: string;
  answerKind: AnswerKind;
  stem: string;
  options?: Record<string, string>;
  parts?: Array<{ label: string; prompt: string }>;
  assets?: Array<{ ref: string; alt?: string; role?: string; mediaType?: string }>;
  language?: string;
  tags?: string[];
  conversionIssues?: string[];
  scoring?: DraftScoring;
  sourceFile: string; // provenance: which file this came from
  sourceDigest?: string;
}

export interface DraftDataset {
  draftId: string;
  datasetId: string;
  version: string;
  status: "draft" | "confirmed" | "discarded";
  format: "markdown" | "json" | "package";
  source: string;
  questions: DraftQuestion[];
  warnings: string[];
  createdAt: string;
  errors?: string[];
  assetDigests?: Record<string, string>;
}

const assetKey = (question: DraftQuestion, ref: string) => sha256OfJsonable({ sourceFile: question.sourceFile, ref });

// ── adapters ─────────────────────────────────────────────────────────────────
function inferAnswerKind(raw: unknown, options?: Record<string, string>): AnswerKind {
  if (typeof raw === "string" && ANSWER_KINDS.has(raw)) return raw as AnswerKind;
  if (raw !== undefined) throw new Error(`不支持的题型：${String(raw)}`);
  return options && Object.keys(options).length >= 2 ? "single_choice" : "open";
}

/** 使用 AST 的来源位置拆分明确题号；带元数据或共享前文的材料保持完整。 */
function splitBlocks(text: string): string[] {
  type Node = { type: string; depth?: number; value?: string; children?: Node[]; position?: { start: { offset?: number } } };
  const tree = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).parse(text) as unknown as Node;
  if (tree.children?.some((node) => node.type === "yaml")) return [text];
  const plain = (node: Node): string => node.value ?? (node.children ?? []).map(plain).join("");
  const headings = (tree.children ?? []).filter((node) => node.type === "heading" && node.depth === 2);
  if (!headings.length || !headings.every((node) => /^(?:\d+|(?:题目|题|question|q)\s*\d+)\s*[:：.、]?$/i.test(plain(node)))) return [text];
  const offsets = headings.map((node) => node.position!.start.offset!);
  if (text.slice(0, offsets[0]).trim()) return [text];
  return offsets.map((offset, i) => text.slice(offset, offsets[i + 1] ?? text.length));
}

export function parseMarkdownSource(text: string, sourceFile: string): DraftQuestion[] {
  return splitBlocks(text).map((block, i) => {
    const parsed = parseQuestionMarkdown(block);
    const fm = parsed.frontmatter;
    const bodyOptions = parseOptionsFromBody(parsed.body);
    const options = (fm.options as Record<string, string> | undefined) ?? (Object.keys(bodyOptions).length >= 2 ? bodyOptions : undefined);
    return {
      id: String(fm.id ?? `q${i + 1}`),
      version: String(fm.version ?? "1"),
      subject: String(fm.subject ?? "general"),
      answerKind: inferAnswerKind(fm.answer_kind, options),
      stem: parsed.body.trim(),
      ...(options ? { options } : {}),
      ...(fm.parts ? { parts: z.array(PublicPartSchema).parse(fm.parts) } : {}),
      ...(fm.language ? { language: z.string().parse(fm.language) } : {}),
      ...(fm.tags ? { tags: z.array(z.string()).parse(fm.tags) } : {}),
      conversionIssues: Object.keys(fm).some((key) => /^(answer|answers|reference|solution|scoring|rubric)$/i.test(key)) ? ["元数据包含评分材料，请分离题面与答案后重新导入。"] : [],
      assets: [...(fm.assets === undefined ? [] : z.array(z.object({ ref: z.string(), alt: z.string().optional(), role: z.string().optional(), mediaType: z.string().optional() }).strict()).parse(fm.assets)),
        ...parsed.imageRefs.filter((image) => !Array.isArray(fm.assets) || !fm.assets.some((asset) => asset.ref === image.ref)).map((r) => ({ ref: r.ref, ...(r.alt ? { alt: r.alt } : {}) }))],
      sourceFile,
    };
  });
}

function normalizeOptions(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    raw.forEach((v, i) => {
      if (typeof v === "string") out[String.fromCharCode(65 + i)] = v;
      else {
        const option = z.object({ label: z.string().min(1), text: z.string() }).strict().parse(v);
        if (option.label in out) throw new Error(`重复选项标签：${option.label}`);
        out[option.label] = option.text;
      }
    });
    return out;
  }
  if (typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (["__proto__", "constructor", "prototype"].includes(k)) throw new Error(`不支持的选项标签：${k}`);
      out[k] = z.string().parse(v);
    }
    return out;
  }
  throw new Error("选项必须是数组或标签与文字的映射。");
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if ((typeof v !== "number" && typeof v !== "string") || !Number.isFinite(n)) throw new Error("数值字段无效");
  return n;
}

function normalizeParts(raw: unknown): Array<{ label: string; prompt: string }> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("小问必须是数组。");
  const out: Array<{ label: string; prompt: string }> = [];
  for (const p of raw) {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      out.push({ label: String(o.label ?? o.id ?? `part${out.length + 1}`), prompt: z.string().parse(o.prompt ?? o.text ?? o.question ?? "") });
    } else throw new Error("小问内容不是对象。");
  }
  return out.length ? out : undefined;
}

export function parseJsonSource(data: unknown, sourceFile: string): DraftQuestion[] {
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { questions?: unknown }).questions)
      ? (data as { questions: unknown[] }).questions
      : data && typeof data === "object" && ("stem" in data || "question" in data) ? [data] : [];
  if (!arr.length) throw new Error("JSON 中没有题目数组或题目对象。");
  const out: DraftQuestion[] = [];
  arr.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`第 ${i + 1} 项不是题目对象。`);
    const o = raw as Record<string, unknown>;
    const pick = (...keys: string[]): unknown => {
      for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
      return undefined;
    };
    const stem = z.string().parse(pick("stem", "question", "text", "prompt", "body") ?? "");
    const parsedBody = parseQuestionMarkdown(stem);
    const bodyOptions = parseOptionsFromBody(stem);
    const options = normalizeOptions(pick("options", "choices")) ?? (Object.keys(bodyOptions).length >= 2 ? bodyOptions : undefined);
    const parts = normalizeParts(pick("parts", "subquestions", "sub_questions"));
    const maxScore = toNumber(pick("maxScore", "max_score", "score", "points"));
    let nested = o.scoring === undefined ? undefined : z.record(z.unknown()).parse(o.scoring);
    if (nested && "questionId" in nested) {
      const full = ScoringSpecSchema.parse(nested);
      if (full.questionId !== String(pick("id", "questionId", "qid") ?? `q${i + 1}`) || full.questionVersion !== String(pick("version") ?? "1") || full.answerKind !== inferAnswerKind(pick("answer_kind", "answerKind", "kind", "type"), options)) throw new Error("嵌套评分与题面身份不匹配。");
      const { questionId: _id, questionVersion: _version, answerKind: _kind, ...basis } = full;
      nested = basis;
    }
    const reference = pick("reference", "answer", "correct", "solution");
    const scoring: DraftScoring | undefined =
      nested ? nested as DraftScoring : maxScore !== undefined || reference !== undefined || o.rubric !== undefined
        ? {
            maxScore,
            reference: typeof reference === "number" ? String(reference) : reference as string | Record<string, string> | undefined,
            scoringVersion: String(pick("scoringVersion", "scoring_version") ?? "1"),
            tolerance: toNumber(pick("tolerance", "tol")),
            units: pick("units") === undefined ? [] : z.array(z.string()).parse(pick("units")),
            deterministicLocked: pick("deterministicLocked", "deterministic_locked", "locked") === undefined ? false : z.boolean().parse(pick("deterministicLocked", "deterministic_locked", "locked")),
            rubric: o.rubric as ScoringSpec["rubric"],
            acceptableAlternatives: o.acceptableAlternatives as string[] | undefined,
            reviewConditions: o.reviewConditions as string | undefined,
          }
        : undefined;
    if (pick("assets", "images", "figures") !== undefined && !Array.isArray(pick("assets", "images", "figures"))) throw new Error("附件必须是数组。");
    const declaredAssets = Array.isArray(pick("assets", "images", "figures"))
      ? (pick("assets", "images", "figures") as unknown[]).map((a) => typeof a === "string" ? { ref: a } : z.object({ ref: z.string().min(1), alt: z.string().optional(), role: z.string().optional(), mediaType: z.string().optional() }).strict().parse(a))
      : undefined;
    const assets = [...(declaredAssets ?? []), ...parsedBody.imageRefs.filter((image) => !declaredAssets?.some((asset) => asset.ref === image.ref)).map((image) => ({ ref: image.ref, alt: image.alt }))];
    out.push({
      id: String(pick("id", "questionId", "qid") ?? `q${i + 1}`),
      version: String(pick("version") ?? "1"),
      subject: String(pick("subject", "topic") ?? "general"),
      answerKind: inferAnswerKind(pick("answer_kind", "answerKind", "kind", "type"), options),
      stem,
      ...(options ? { options } : {}),
      ...(parts ? { parts } : {}),
      ...(assets && assets.length ? { assets } : {}),
      ...(scoring ? { scoring } : {}),
      language: o.language === undefined ? undefined : z.string().parse(o.language),
      tags: o.tags === undefined ? undefined : z.array(z.string()).parse(o.tags),
      conversionIssues: Object.keys(parsedBody.frontmatter).some((key) => /^(answer|answers|reference|solution|scoring|rubric)$/i.test(key)) ? ["题面包含评分元数据，请分离后重新导入。"] : [],
      sourceFile,
    });
  });
  return out;
}

// ── serialisation (confirm) ──────────────────────────────────────────────────
function questionToMarkdown(q: DraftQuestion): string {
  const question = publicQuestion(q);
  const fm: Record<string, unknown> = {
    id: q.id,
    version: q.version,
    subject: q.subject,
    answer_kind: q.answerKind,
    ...(q.options && Object.keys(q.options).length ? { options: q.options } : {}),
    ...(q.parts && q.parts.length ? { parts: q.parts } : {}),
    language: question.language,
    tags: question.tags,
    assets: question.assets,
  };
  return `---\n${YAML.stringify(fm)}---\n\n${q.stem}\n`;
}

/** Build a valid scoring JSON, or undefined when the basis is incomplete. */
function scoringToJson(q: DraftQuestion): string | undefined {
  const s = q.scoring;
  if (!scoringComplete(s) || !s) return undefined;
  return JSON.stringify(scoringSpec(q), null, 2) + "\n";
}

const DraftSchema = z.object({
  draftId: z.string(), datasetId: z.string(), version: VersionSchema,
  status: z.enum(["draft", "confirmed", "discarded"]), format: z.enum(["markdown", "json", "package"]),
  source: z.string(), createdAt: z.string(), warnings: z.array(z.string()), errors: z.array(z.string()).optional(),
  assetDigests: z.record(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  questions: z.array(z.object({
    id: z.string(), version: z.string(), subject: z.string(), answerKind: z.enum(["single_choice", "multi_choice", "numeric_unit", "multi_blank", "expression", "open", "out_of_scope"]),
    stem: z.string(), sourceFile: z.string(), sourceDigest: z.string().optional(), options: z.record(z.string()).optional(), parts: z.array(PublicPartSchema).optional(),
    assets: z.array(z.object({ ref: z.string(), alt: z.string().optional(), role: z.string().optional(), mediaType: z.string().optional() }).strict()).optional(),
    scoring: ScoringSpecSchema.omit({ questionId: true, questionVersion: true, answerKind: true }).partial().optional(),
    language: z.string().optional(), tags: z.array(z.string()).optional(), conversionIssues: z.array(z.string()).optional(),
  }).strict()),
}).strict();

export type DraftEditField = "stem" | "metadata" | "scoring";
const MetadataSchema = DraftSchema.shape.questions.element.omit({ stem: true, sourceFile: true, sourceDigest: true, scoring: true, conversionIssues: true });

export interface DraftQuestionReview {
  draft: DraftDataset;
  index: number;
  digest: string;
  sourceText: string;
  sourceError?: string;
  modelText: string;
  metadataText: string;
  scoringText: string;
  check: ConvertCheck;
}

// ── service ──────────────────────────────────────────────────────────────────
export interface ConfirmResult {
  datasetId: string;
  questions: number;
  scored: number;
  assetsCopied: number;
  path: string;
}

export class ImportService {
  constructor(private readonly datasetsRoot: string, private readonly importRoot = ".import") {}

  private captureAssets(questions: DraftQuestion[], previous: Record<string, string> = {}): Record<string, string> {
    const captured = { ...previous };
    for (const q of questions) for (const asset of q.assets ?? []) {
      const key = assetKey(q, asset.ref);
      if (captured[key]) continue;
      try { captured[key] = sha256OfBytes(readFileSync(resolvePublicAttachment(dirname(q.sourceFile), asset.ref))); }
      catch { /* 缺失或越界附件仍保留为待修正草稿，统一校验会显示错误并拒绝入库。 */ }
    }
    return captured;
  }

  private collectFiles(sourcePath: string): string[] {
    const st = statSync(sourcePath);
    if (st.isFile()) {
      if (!/\.(md|txt|json)$/i.test(sourcePath)) throw new Error("仅支持 Markdown、TXT、JSON 或标准题目包。");
      return [sourcePath];
    }
    if (!st.isDirectory()) return [];
    const out: string[] = [];
    const base = existsSync(join(sourcePath, "public")) ? join(sourcePath, "public") : sourcePath;
    for (const f of readdirSync(base).sort()) {
      const p = join(base, f);
      if (statSync(p).isFile() && /\.(md|txt|json)$/i.test(f)) out.push(resolvePublicAttachment(sourcePath, base === sourcePath ? f : `public/${f}`));
    }
    return out;
  }

  /** Parse external material into a STAGED draft (datasets/ untouched). */
  importSource(sourcePath: string, opts: { datasetId: string; version?: string }): DraftDataset {
    validateImportId(opts.datasetId);
    VersionSchema.parse(opts.version ?? "1");
    sourcePath = resolve(sourcePath);
    const files = this.collectFiles(sourcePath);
    if (files.length === 0) throw new Error(`no importable files (.md/.txt/.json) at: ${sourcePath}`);
    const questions: DraftQuestion[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let format: DraftDataset["format"] = existsSync(join(sourcePath, "public")) ? "package" : "markdown";
    for (const f of files) {
      try {
        if (/\.json$/i.test(f)) {
          if (format !== "package") format = "json";
          questions.push(...parseJsonSource(JSON.parse(readFileSync(f, "utf8")), f));
        } else {
          questions.push(...parseMarkdownSource(readFileSync(f, "utf8"), f));
        }
      } catch (e) {
        errors.push(`${f}: 转换失败 — ${(e as Error).message}`);
      }
    }
    if (format === "package") {
      for (const q of questions) {
        try {
          validateImportId(q.id);
          const file = join(sourcePath, "scoring", `${q.id}.json`);
          if (!existsSync(file)) continue;
          const scoring = ScoringSpecSchema.parse(JSON.parse(readFileSync(resolvePublicAttachment(sourcePath, `scoring/${q.id}.json`), "utf8")));
          if (scoring.questionId !== q.id || scoring.questionVersion !== q.version || scoring.answerKind !== q.answerKind) throw new Error("评分与题面身份不匹配");
          const { questionId: _id, questionVersion: _version, answerKind: _kind, ...basis } = scoring;
          q.scoring = basis;
        } catch (error) { errors.push(`${q.id}: ${(error as Error).message}`); }
      }
    }
    const seen = new Set<string>();
    for (const q of questions) {
      q.sourceDigest = sha256OfText(readFileSync(q.sourceFile).toString("base64"));
      if (seen.has(q.id)) warnings.push(`重复题号：${q.id}（请修正来源后重新导入）`);
      seen.add(q.id);
      if (!scoringComplete(q.scoring)) warnings.push(`${q.id}: 缺少完整评分依据（未评分：可收集答卷，不计入正式分）`);
    }
    const draftId = `draft-${randomUUID()}`;
    const draft: DraftDataset = { draftId, datasetId: opts.datasetId, version: opts.version ?? "1", status: "draft", format, source: sourcePath, questions, warnings, errors, assetDigests: this.captureAssets(questions), createdAt: new Date().toISOString() };
    DraftSchema.parse(draft);
    mkdirSync(join(this.importRoot, draftId), { recursive: true });
    writeJsonAtomic(join(this.importRoot, draftId, "draft.json"), draft);
    return draft;
  }

  private draftPath(draftId: string): string {
    validateImportId(draftId);
    const directory = resolveWithin(this.importRoot, draftId);
    return resolvePublicAttachment(directory, "draft.json");
  }

  listDrafts(): DraftDataset[] {
    if (!existsSync(this.importRoot)) return [];
    const out: DraftDataset[] = [];
    for (const d of readdirSync(this.importRoot).sort()) {
      const p = join(this.importRoot, d, "draft.json");
      if (!existsSync(p)) continue;
      const draft = this.getDraft(d);
      if (draft?.status === "draft") out.push(draft);
    }
    return out;
  }

  getDraft(draftId: string): DraftDataset | undefined {
    validateImportId(draftId);
    const directory = resolveWithin(this.importRoot, draftId);
    const p = join(directory, "draft.json");
    if (!existsSync(p)) return undefined;
    if (realpathSync(directory) !== join(realpathSync(resolve(this.importRoot)), draftId)) throw new Error("草稿目录发生路径跳转。");
    const draft = DraftSchema.parse(JSON.parse(readFileSync(this.draftPath(draftId), "utf8")));
    if (draft.draftId !== draftId) throw new Error("草稿标识与目录不匹配。");
    validateImportId(draft.datasetId);
    return draft;
  }

  private currentSource(draft: DraftDataset, index: number): { question: DraftQuestion; text: string } {
    const question = draft.questions[index];
    if (!question) throw new Error("所选题目不存在。");
    const root = statSync(draft.source).isDirectory() ? draft.source : dirname(draft.source);
    const source = readFileSync(resolvePublicAttachment(root, relative(root, question.sourceFile)));
    if (!question.sourceDigest || sha256OfText(source.toString("base64")) !== question.sourceDigest) throw new Error("来源文件已变化或缺少摘要，请重新导入；不能将当前文件当作导入时原文。");
    return { question, text: source.toString("utf8") };
  }

  /** 原文为完整来源文件，模型预览与真实请求共用同一构建函数，评分单独展示。 */
  reviewQuestion(draftId: string, index: number): DraftQuestionReview {
    const draft = this.getDraft(draftId);
    if (!draft || !draft.questions[index]) throw new Error("草稿或所选题目不存在。");
    const q = draft.questions[index]!;
    let sourceText = "", sourceError: string | undefined;
    try { sourceText = this.currentSource(draft, index).text; }
    catch (error) { sourceError = (error as Error).message; }
    let modelText: string;
    try { modelText = buildUserContent(publicQuestion(q)); }
    catch (error) { modelText = `公开题面校验失败，请编辑修正：${(error as Error).message}\n\n当前草稿题干：\n${q.stem}`; }
    const { stem: _stem, sourceFile: _source, sourceDigest: _digest, scoring: _scoring, conversionIssues: _issues, ...metadata } = q;
    return { draft, index, digest: sha256OfJsonable(draft), sourceText, sourceError, modelText,
      metadataText: JSON.stringify(metadata, null, 2), scoringText: JSON.stringify(q.scoring ?? null, null, 2), check: this.check(draftId) };
  }

  /** 只修改未发布草稿；旧版本保存为独立快照，陈旧编辑和来源变化不能覆盖当前内容。 */
  editQuestion(draftId: string, index: number, expectedDigest: string, field: DraftEditField, text: string): DraftQuestionReview {
    const draft = this.getDraft(draftId);
    if (!draft || draft.status !== "draft") throw new Error("只能编辑未确认的草稿。");
    const targetId = validateImportId(draft.version === "1" ? draft.datasetId : `${draft.datasetId}.v${draft.version}`);
    if (existsSync(resolveWithin(this.datasetsRoot, targetId))) throw new Error("该草稿对应版本已经发布，禁止继续修改；请导入新版本。");
    if (sha256OfJsonable(draft) !== expectedDigest) throw new Error("草稿已被其他操作更新，请重新打开题目后编辑。");
    const { question } = this.currentSource(draft, index);
    let edited: DraftQuestion;
    if (field === "stem") {
      if (!text.trim()) throw new Error("题面不能为空。");
      edited = { ...question, stem: text };
    } else if (field === "metadata") {
      const metadata = MetadataSchema.parse(JSON.parse(text));
      edited = { ...metadata, stem: question.stem, scoring: question.scoring, sourceFile: question.sourceFile,
        sourceDigest: question.sourceDigest, conversionIssues: question.conversionIssues };
    } else if (field === "scoring") {
      const value: unknown = JSON.parse(text);
      edited = { ...question, scoring: value === null ? undefined : ScoringSpecSchema.omit({ questionId: true, questionVersion: true, answerKind: true }).partial().parse(value) };
    } else throw new Error("不支持的编辑字段。");
    // 重新从 Markdown AST 收集新增图片引用；缺图将由统一校验阻止入库。
    const images = parseQuestionMarkdown(edited.stem).imageRefs;
    edited.assets = [...(edited.assets ?? []), ...images.filter((image) => !edited.assets?.some((asset) => asset.ref === image.ref)).map((image) => ({ ref: image.ref, alt: image.alt }))];
    const next = DraftSchema.parse({ ...draft, questions: draft.questions.map((q, i) => i === index ? edited : q) });
    next.assetDigests = this.captureAssets([{ ...edited, assets: edited.assets?.filter((asset) => field === "metadata" || !question.assets?.some((previous) => previous.ref === asset.ref)) }], draft.assetDigests);
    next.warnings = checkDraft(next).warnings;
    writeJsonAtomic(join(dirname(this.draftPath(draftId)), `revision-${randomUUID()}.json`), { at: new Date().toISOString(), field, index, before: draft, afterDigest: sha256OfJsonable(next) });
    writeJsonAtomic(this.draftPath(draftId), next);
    return this.reviewQuestion(draftId, index);
  }

  /** 图片预览和打开原图共用此路径边界，不接受任意文件或外部地址。 */
  reviewAsset(draftId: string, index: number, assetIndex: number): { path: string; ref: string } {
    const draft = this.getDraft(draftId);
    if (!draft) throw new Error("草稿不存在。");
    const { question } = this.currentSource(draft, index);
    const asset = question.assets?.[assetIndex];
    if (!asset) throw new Error("该题没有所选附件。");
    const path = resolvePublicAttachment(dirname(question.sourceFile), asset.ref);
    const digest = draft.assetDigests?.[assetKey(question, asset.ref)];
    if (!digest || digest !== sha256OfBytes(readFileSync(path))) throw new Error("附件已变化或缺少原始摘要，请重新导入或明确修正草稿附件引用。");
    return { path, ref: asset.ref };
  }

  /** Conversion check for a staged draft (Next_Plan §3 step 5). */
  check(draftId: string): ConvertCheck {
    const draft = this.getDraft(draftId);
    if (!draft) throw new Error(`draft not found: ${draftId}`);
    let sourceDir: string | undefined;
    try {
      if (existsSync(draft.source) && statSync(draft.source).isDirectory()) sourceDir = draft.source;
    } catch {
      sourceDir = undefined;
    }
    const result = checkDraft(draft, sourceDir ? { sourceDir } : {});
    if (draft.questions.some((question) => !question.sourceDigest)) {
      result.issues.push("旧草稿缺少来源摘要，请重新导入来源材料后确认。");
      result.ok = false;
    }
    for (let index = 0; index < draft.questions.length; index++) {
      if (!draft.questions[index]!.sourceDigest) continue;
      try { this.currentSource(draft, index); }
      catch (error) {
        result.questions.push({ questionId: draft.questions[index]!.id, issues: [(error as Error).message] });
        result.ok = false;
      }
    }
    for (const q of draft.questions) for (const asset of q.assets ?? []) {
      try {
        const path = resolvePublicAttachment(dirname(q.sourceFile), asset.ref);
        const expected = draft.assetDigests?.[assetKey(q, asset.ref)];
        if (!expected || expected !== sha256OfBytes(readFileSync(path))) throw new Error("附件已变化或缺少原始摘要，请重新导入或明确修正附件引用。");
      } catch (error) {
        result.questions.push({ questionId: q.id, issues: [`${asset.ref}：${(error as Error).message}`] });
        result.ok = false;
      }
    }
    return result;
  }

  /** Promote a staged draft into the formal datasets/<id>/ (canonical layout). */
  async confirmDraft(draftId: string): Promise<ConfirmResult> {
    const draft = this.getDraft(draftId);
    if (!draft) throw new Error(`draft not found: ${draftId}`);
    if (draft.status !== "draft") throw new Error(`draft already ${draft.status}`);
    const datasetId = validateImportId(draft.version === "1" ? draft.datasetId : `${draft.datasetId}.v${draft.version}`);
    const target = resolveWithin(this.datasetsRoot, datasetId);
    if (existsSync(target)) {
      const versionFile = join(target, "VERSION.json");
      const owner = existsSync(versionFile) ? z.object({ sourceDraftId: z.literal(draftId), datasetId: z.literal(datasetId), version: z.literal(draft.version), status: z.literal("confirmed"),
        result: z.object({ questions: z.number().int().nonnegative(), scored: z.number().int().nonnegative(), assetsCopied: z.number().int().nonnegative() }) })
        .passthrough().safeParse(JSON.parse(readFileSync(resolvePublicAttachment(target, "VERSION.json"), "utf8"))) : undefined;
      if (!owner?.success) throw new Error("该题集版本已存在，禁止覆盖。请指定新的题集标识或版本。");
      // 发布已完成但状态写入中断时，只恢复草稿状态，不重新写入题集。
      draft.status = "confirmed";
      writeJsonAtomic(this.draftPath(draftId), draft);
      return { datasetId, path: target, ...owner.data.result };
    }
    const check = this.check(draftId);
    if (!check.ok) throw new Error(`入库校验失败：${[...check.issues, ...check.questions.flatMap((q) => q.issues)].join("；")}`);
    // 在草稿目录准备并校验完整内容，发布失败时保留材料，不暴露半成品题集。
    const candidate = join(dirname(this.draftPath(draftId)), `publish-${randomUUID()}`);
    const publicDir = join(candidate, "public");
    const scoringDir = join(candidate, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    let scored = 0;
    const sources: Array<{ id: string; sourceFile: string; storedFile: string; digest: string }> = [];
    for (const q of draft.questions) {
      validateImportId(q.id);
      writeFileSync(resolveWithin(publicDir, `${q.id}.md`), questionToMarkdown(q), "utf8");
      const sj = scoringToJson(q);
      if (sj) {
        writeFileSync(join(scoringDir, `${q.id}.json`), sj, "utf8");
        scored++;
      }
      const source = readFileSync(q.sourceFile);
      const digest = sha256OfText(source.toString("base64"));
      if (q.sourceDigest && q.sourceDigest !== digest) throw new Error(`来源文件已变化，请重新导入：${q.sourceFile}`);
      const storedFile = `source/${sources.length}-${basename(q.sourceFile)}`;
      const storedPath = resolveWithin(candidate, storedFile);
      mkdirSync(dirname(storedPath), { recursive: true });
      writeFileSync(storedPath, source);
      sources.push({ id: q.id, sourceFile: q.sourceFile, storedFile, digest });
    }
    // 原图按来源文件所在目录解析，共享附件只复制一次，来源内容保持原样。
    let assetsCopied = 0;
    for (const q of draft.questions) {
      const sourceDir = dirname(q.sourceFile);
      for (const a of q.assets ?? []) {
        const from = resolvePublicAttachment(sourceDir, a.ref);
        const bytes = readFileSync(from);
        if (draft.assetDigests?.[assetKey(q, a.ref)] !== sha256OfBytes(bytes)) throw new Error(`附件已变化，请重新导入：${a.ref}`);
        const to = resolveWithin(publicDir, a.ref);
        if (existsSync(to)) {
          if (!bytes.equals(readFileSync(to))) throw new Error(`同名附件内容冲突：${a.ref}`);
        } else {
          mkdirSync(dirname(to), { recursive: true });
          writeFileSync(to, bytes);
          assetsCopied++;
        }
      }
    }
    const loaded = await importDataset({ datasetId, publicDir, scoringDir });
    if (!loaded.ok || loaded.entries.length !== draft.questions.length) throw new Error(`发布前校验失败：${loaded.entries.flatMap((entry) => entry.errors).join("；")}`);
    for (const entry of loaded.entries) {
      const original = draft.questions.find((q) => q.id === entry.questionId)!;
      if (sha256OfJsonable(entry.question) !== sha256OfJsonable(publicQuestion(original))) throw new Error(`题目转换前后不一致：${entry.questionId}`);
    }
    const publicDigest = sha256OfJsonable(loaded.entries.map((entry) => ({ id: entry.questionId, content: entry.contentDigest })));
    const scoringDigest = sha256OfJsonable(loaded.entries.map((entry) => entry.scoring ?? null));
    writeJsonAtomic(join(candidate, "VERSION.json"), {
      schema: "pi-exam-dataset-version/1",
      datasetId, logicalDatasetId: draft.datasetId,
      version: draft.version,
      status: "confirmed",
      questionIds: draft.questions.map((q) => q.id),
      publicDigest, scoringDigest, sourceDraftId: draftId,
      result: { questions: draft.questions.length, scored, assetsCopied },
      createdAt: new Date().toISOString(),
    });
    writeJsonAtomic(join(candidate, "SOURCE.json"), { source: draft.source, questions: sources });
    mkdirSync(this.datasetsRoot, { recursive: true });
    const claim = resolveWithin(this.datasetsRoot, `.publication-${datasetId}.json`);
    try {
      writeFileSync(claim, JSON.stringify({ datasetId, draftId }), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = z.object({ datasetId: z.literal(datasetId), draftId: z.literal(draftId) }).strict()
        .safeParse(JSON.parse(readFileSync(resolvePublicAttachment(this.datasetsRoot, `.publication-${datasetId}.json`), "utf8")));
      if (!owner.success) throw new Error("该版本已由另一草稿占用，请指定新版本。");
    }
    if (existsSync(target)) throw new Error("发布目标已被另一导入占用，请重新选择版本。");
    renameSync(candidate, target);
    draft.status = "confirmed";
    try { writeJsonAtomic(this.draftPath(draftId), draft); }
    catch (error) { throw new Error(`题集 ${datasetId} 已发布，但草稿状态保存失败：${(error as Error).message}`); }
    return { datasetId, questions: draft.questions.length, scored, assetsCopied, path: target };
  }

  /** 归档草稿只更新状态，保留原数据；返回页面不会触发归档。 */
  discardDraft(draftId: string): void {
    const draft = this.getDraft(draftId);
    if (!draft) throw new Error("草稿不存在。");
    if (draft.status !== "draft") throw new Error("只能归档未确认的草稿。");
    writeJsonAtomic(this.draftPath(draftId), { ...draft, status: "discarded" });
  }

  /** The formal question bank: confirmed datasets + their question counts. */
  listBank(): Array<{ datasetId: string; questions: number }> {
    if (!existsSync(this.datasetsRoot)) return [];
    const out: Array<{ datasetId: string; questions: number }> = [];
    for (const name of readdirSync(this.datasetsRoot).sort()) {
      const publicDir = join(this.datasetsRoot, name, "public");
      if (!existsSync(publicDir)) continue;
      const questions = readdirSync(publicDir).filter((f) => f.toLowerCase().endsWith(".md")).length;
      out.push({ datasetId: name, questions });
    }
    return out;
  }
}
