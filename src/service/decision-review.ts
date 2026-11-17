/**
 * 第二阶段 /review 决策辅助服务（AGENTS.md §12）。只读取真实归档 Trial
 * （loadValidAnswers —— 与报告同一套校验来源），只允许 executionStatus
 * completed 且有 finalAnswerSheet 的答卷；不写 grade、不重跑作答、不改报告。
 *
 * 证据逐段校验必须确实来自原答卷：
 * - 象信 span：providerStart/providerEnd 是 Unicode 码点左闭右开，用
 *   Array.from 切片并换算成 JS UTF16 码元位置；path 必须对应答卷。
 * - 蚂蚁 extract：offset 编码未明确，按 UTF16 / codepoint / UTF8 字节候选逐一
 *   验证 text，只有唯一匹配才接受并记录实际 encoding；任何不符、重复歧义、
 *   truncated 都记为定位失败，保留人工核对，绝不伪造坐标。
 * 结果追加到 trial 目录 decision-reviews.jsonl，最新一份原子写 decision-review.json；
 * 返回前再次核对 trial 材料 digest，变化则不保存。
 */
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import type { AnswerMode, Grade, PublicQuestion, ScoringSpec, Trial } from "../shared/contracts.js";
import {
  DECISION_ASSISTANCE_SCHEMA,
  DecisionAssistanceRecordSchema,
  type DecisionAssistanceRecord,
  type DecisionEvidence,
  type DecisionProviderProfile,
} from "../shared/decision.js";
import { SystemOneClient, SystemOneError, DecisionChoiceConclusions, type DecisionQuestion, type ExtractSpan, type SpanSpan } from "../providers/systemone.js";
import { loadValidAnswers } from "../runner/answer-source.js";
import { appendJsonl, pathJoin, readJson, readJsonl, writeJsonAtomic } from "../shared/json.js";

export const CHOICE_QUESTION_ID = "conclusion_kind";
export const NOUL_QUESTION_ID = "has_explicit_conclusion";
export const MULTI_CHOICE_QUESTION_ID = "selected_options";
export const EXTRACT_QUESTION_ID = "answer_evidence";
export const SPAN_QUESTION_ID = "answer_evidence_span";

/** 题面选项标签的边界匹配：前后不得紧跟字母/数字（如 "A" 不得命中 "AA" 或 "A1"）。 */
function optionLabelPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`);
}

/** 选项是否至少有一条已验证原文证据支持（证据 quote 内边界清晰命中标签）。 */
export function evidenceSupportsOption(evidence: DecisionEvidence[], label: string): boolean {
  const pattern = optionLabelPattern(label);
  return evidence.some((e) => pattern.test(e.quote));
}

/** 象信 span：码点左闭右开 → 校验 text 并换算 UTF16 码元位置。 */
export function verifySpanEvidence(answer: string, span: SpanSpan): { ok: true; evidence: DecisionEvidence } | { ok: false; reason: string } {
  if (span.path !== "") return { ok: false, reason: `path=${JSON.stringify(span.path)} 不对应答卷字符串` };
  const codepoints = Array.from(answer);
  if (span.start < 0 || span.end > codepoints.length || span.end <= span.start) {
    return { ok: false, reason: `码点位置越界 [${span.start},${span.end})（答卷共 ${codepoints.length} 码点）` };
  }
  const slice = codepoints.slice(span.start, span.end).join("");
  if (slice !== span.text) {
    return { ok: false, reason: `码点 [${span.start},${span.end}) 处原文为 ${JSON.stringify(slice)}，与 provider text 不符` };
  }
  // 换算成 JS UTF16 码元位置（UI 使用）。
  let start = 0;
  for (let i = 0; i < span.start; i++) start += codepoints[i]!.length;
  let end = start;
  for (let i = span.start; i < span.end; i++) end += codepoints[i]!.length;
  return {
    ok: true,
    evidence: {
      quote: slice, start, end,
      providerStart: span.start, providerEnd: span.end,
      encoding: "codepoint", providerPath: span.path,
      confidence: span.confidence ?? 0,
    },
  };
}

export interface ExtractCandidate {
  encoding: "utf16" | "codepoint" | "utf8";
  start: number; // UTF16 码元
  end: number;   // UTF16 码元
}

/**
 * 蚂蚁 extract：offset 编码未明确，按 UTF16 / codepoint / UTF8 字节三种候选
 * 解释 providerStart/providerEnd，逐一验证切片是否精确等于 text；
 * 只有唯一匹配才接受并返回实际编码。重复歧义或全部不符 → 定位失败。
 */
export function resolveExtractOffset(answer: string, text: string, providerStart: number, providerEnd: number): ExtractCandidate[] {
  const codepoints = Array.from(answer);
  // UTF16 候选。
  const candidates: ExtractCandidate[] = [];
  if (providerEnd <= answer.length && providerEnd > providerStart && answer.slice(providerStart, providerEnd) === text) {
    candidates.push({ encoding: "utf16", start: providerStart, end: providerEnd });
  }
  // codepoint 候选。
  if (providerEnd <= codepoints.length && providerEnd > providerStart) {
    let start = 0;
    for (let i = 0; i < providerStart; i++) start += codepoints[i]!.length;
    let end = start;
    for (let i = providerStart; i < providerEnd; i++) end += codepoints[i]!.length;
    if (answer.slice(start, end) === text && !candidates.some((c) => c.encoding === "utf16" && c.start === start && c.end === end)) {
      candidates.push({ encoding: "codepoint", start, end });
    }
  }
  // UTF8 字节候选。
  const bytes = Buffer.from(answer, "utf8");
  if (providerEnd <= bytes.length && providerEnd > providerStart && bytes.subarray(providerStart, providerEnd).toString("utf8") === text) {
    const start = bytes.subarray(0, providerStart).toString("utf8").length;
    const end = start + text.length;
    if (answer.slice(start, end) === text && !candidates.some((c) => c.start === start && c.end === end)) {
      candidates.push({ encoding: "utf8", start, end });
    }
  }
  return candidates;
}

export function verifyExtractEvidence(answer: string, span: ExtractSpan): { ok: true; evidence: DecisionEvidence } | { ok: false; reason: string } {
  if (span.start < 0 || span.end <= span.start) return { ok: false, reason: `offset 非法 [${span.start},${span.end})` };
  const matches = resolveExtractOffset(answer, span.text, span.start, span.end);
  if (matches.length === 0) return { ok: false, reason: `UTF16/codepoint/UTF8 三种编码均无法在 [${span.start},${span.end}) 处匹配原文` };
  if (matches.length > 1) return { ok: false, reason: `offset 在多种编码解释下歧义匹配（${matches.map((m) => m.encoding).join("/")}），无法确认实际编码` };
  const m = matches[0]!;
  return {
    ok: true,
    evidence: {
      quote: answer.slice(m.start, m.end), start: m.start, end: m.end,
      providerStart: span.start, providerEnd: span.end,
      encoding: m.encoding, providerPath: "", confidence: span.confidence ?? 0,
    },
  };
}

function materialDigest(trial: Trial, question: PublicQuestion | undefined, scoring: ScoringSpec | undefined, grade: Grade | undefined): string {
  return createHash("sha256").update(JSON.stringify({ trial, question, scoring, grade })).digest("hex");
}

export interface AssistParams {
  runId: string;
  mode: AnswerMode;
  trialId: string;
  profile: DecisionProviderProfile;
  client: SystemOneClient;
  signal?: AbortSignal;
}

export class DecisionReviewService {
  constructor(private readonly runsRoot: string, private readonly datasetDir: string, private readonly datasetId: string) {}

  private trialDir(runId: string, trialId: string): string {
    return pathJoin(this.runsRoot, runId, "trials", trialId);
  }

  /** 某 trial 的全部辅助记录（按追加顺序）。 */
  async getHistory(runId: string, trialId: string): Promise<DecisionAssistanceRecord[]> {
    const records = readJsonl<unknown>(pathJoin(this.trialDir(runId, trialId), "decision-reviews.jsonl"));
    const out: DecisionAssistanceRecord[] = [];
    for (const raw of records) {
      const parsed = DecisionAssistanceRecordSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /** 最近一次辅助记录（decision-review.json；损坏时回退到 jsonl 最后一条合法记录）。 */
  async getLatest(runId: string, trialId: string): Promise<DecisionAssistanceRecord | undefined> {
    const raw = readJson<unknown>(pathJoin(this.trialDir(runId, trialId), "decision-review.json"));
    const parsed = raw === undefined ? undefined : DecisionAssistanceRecordSchema.safeParse(raw);
    if (parsed?.success) return parsed.data;
    const history = await this.getHistory(runId, trialId);
    return history[history.length - 1];
  }

  /** 构造本次请求的问题集：共同 choice/noul；蚂蚁加 multi-choice/extract；象信加 span。
   *  不在 profile 能力内的问题不发送，并显式记录到 limitations。
   *  choice/multi-choice 的 criteria 描述由调用侧提供（缺省时回退选项名）。 */
  buildQuestions(question: PublicQuestion | undefined, profile: DecisionProviderProfile): { questions: DecisionQuestion[]; limitations: string[]; stemOptions: string[] } {
    const questions: DecisionQuestion[] = [];
    const limitations: string[] = [];
    const has = (c: DecisionProviderProfile["capabilities"][number]) => profile.capabilities.includes(c);
    if (has("choice")) {
      questions.push({
        id: CHOICE_QUESTION_ID, type: "choice",
        question: "答卷对题目给出了怎样的最终结论？",
        options: [...DecisionChoiceConclusions],
        optionDescriptions: {
          explicit_single: "明确给出单一最终结论",
          explicit_multiple: "明确给出多个最终结论",
          no_conclusion: "未给出最终结论",
          insufficient_evidence: "答卷证据不足以下结论",
        },
      });
    } else {
      limitations.push(`profile ${profile.id} 无 choice 能力，未发送结论类型问题。`);
    }
    if (has("noul")) {
      questions.push({ id: NOUL_QUESTION_ID, type: "noul", question: "答卷是否有明确的最终结论？0=完全没有，1=明确给出。" });
    } else {
      limitations.push(`profile ${profile.id} 无 noul 能力，未发送结论明确度问题。`);
    }
    const stemOptions = Object.keys(question?.options ?? {}).filter((label) => /^[A-Z]$/.test(label)).sort();
    if (has("multi-choice")) {
      if (stemOptions.length) {
        questions.push({
          id: MULTI_CHOICE_QUESTION_ID, type: "multi-choice",
          question: `答卷最终选择了题面哪些选项？候选：${stemOptions.join("、")}。只统计最终结论，排除被明确排除的提及项；数值/单位只提取证据，不套选项。`,
          options: stemOptions,
        });
      } else {
        limitations.push(`题目没有 A..Z 选项，未发送 multi-choice 问题（不做静默降级）。`);
      }
    } else {
      limitations.push(`profile ${profile.id} 无 multi-choice 能力，未发送题面选项多选问题。`);
    }
    if (has("extract")) {
      questions.push({ id: EXTRACT_QUESTION_ID, type: "extract", question: "从答卷原文中提取支持最终结论的证据片段（保持原文，标注位置）。" });
    } else {
      limitations.push(`profile ${profile.id} 无 extract 能力，未发送原文证据提取问题。`);
    }
    if (has("span")) {
      questions.push({ id: SPAN_QUESTION_ID, type: "span", question: "在答卷字符串中定位支持最终结论的证据片段（span，码点位置）。" });
    } else {
      limitations.push(`profile ${profile.id} 无 span 能力，未发送原文证据定位问题。`);
    }
    return { questions, limitations, stemOptions };
  }

  /** 对一次决策结果做证据定位校验，返回可采信证据与定位失败清单。 */
  verifyAnswerEvidence(answer: string, questions: DecisionQuestion[], resultAnswers: Record<string, import("../providers/systemone.js").DecisionAnswer>): { evidence: DecisionEvidence[]; unlocalized: Array<{ quote: string; providerPath: string; reason: string }> } {
    const evidence: DecisionEvidence[] = [];
    const unlocalized: Array<{ quote: string; providerPath: string; reason: string }> = [];
    const extractQ = questions.find((q) => q.type === "extract");
    const spanQ = questions.find((q) => q.type === "span");
    const extractAnswer = extractQ ? resultAnswers[extractQ.id] : undefined;
    if (extractAnswer?.type === "extract") {
      if (extractAnswer.truncated) {
        unlocalized.push({ quote: "(extract truncated)", providerPath: "", reason: "provider 报告证据被截断（truncated），定位不可信" });
      }
      for (const span of extractAnswer.spans) {
        const verified = verifyExtractEvidence(answer, span);
        if (verified.ok) evidence.push(verified.evidence);
        else unlocalized.push({ quote: span.text, providerPath: "", reason: verified.reason });
      }
    }
    const spanAnswer = spanQ ? resultAnswers[spanQ.id] : undefined;
    if (spanAnswer?.type === "span") {
      for (const span of spanAnswer.spans) {
        const verified = verifySpanEvidence(answer, span);
        if (verified.ok) evidence.push(verified.evidence);
        else unlocalized.push({ quote: span.text, providerPath: span.path, reason: verified.reason });
      }
    }
    // 证据重叠去重（同一位置同一原文只保留一次）。
    const seen = new Set<string>();
    const deduped = evidence.filter((e) => {
      const key = `${e.start}:${e.end}:${e.quote}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { evidence: deduped, unlocalized };
  }

  /**
   * 对一份真实归档答卷发起一次决策辅助。绝不写 grade/报告/原答卷；
   * 成功/失败/结果未知都会生成记录，返回前重新核对材料 digest，变化则不保存。
   */
  async assist(params: AssistParams): Promise<DecisionAssistanceRecord> {
    const { runId, mode, trialId, profile, client, signal } = params;
    const va = await loadValidAnswers(this.runsRoot, runId, this.datasetDir, this.datasetId, mode);
    const trial = va.trials.find((t) => t.trialId === trialId);
    if (!trial) throw new Error(`trial not found among ${runId}'s valid answers: ${trialId}`);
    const loc = va.locations.get(trialId);
    if (!loc) throw new Error(`no source location for ${trialId}`);
    if (trial.executionStatus !== "completed" || !trial.finalAnswerSheet?.trim()) {
      throw new Error("只有已完成且有有效答卷的记录可以做决策辅助。");
    }
    const question = va.questions.get(trial.questionId);
    const scoring = va.scorings.get(trial.questionId);
    const grade = va.grades.find((g) => g.trialId === trialId);
    const digest = materialDigest(trial, question, scoring, grade);
    const answer = trial.finalAnswerSheet;
    const { questions, limitations, stemOptions } = this.buildQuestions(question, profile);

    const base = {
      recordId: `decision-${randomBytes(6).toString("hex")}`,
      schemaVersion: DECISION_ASSISTANCE_SCHEMA,
      trialId, sourceRunId: loc.runId, mode,
      providerId: profile.id, requestedModel: profile.model,
      actualModel: null as string | null,
      status: "failed" as const,
      needsHumanReview: true as const,
      choice: null, noul: null, probabilities: null, confidence: null,
      selectedOptions: [] as string[], evidence: [] as DecisionEvidence[],
      usage: null, requestId: null,
      latencyMs: null as number | null,
      providerModelMs: null as number | null,
      providerTotalMs: null as number | null,
      warnings: [] as string[], error: null,
      rawSafeResponse: null as unknown,
      limitations, unlocalizedEvidence: [] as Array<{ quote: string; providerPath: string; reason: string }>,
      createdAt: new Date().toISOString(),
    };

    let record: DecisionAssistanceRecord;
    try {
      const result = await client.decide(answer, questions, { signal });
      const verified = this.verifyAnswerEvidence(answer, questions, result.answers);
      const choiceAnswer = result.answers[CHOICE_QUESTION_ID];
      const noulAnswer = result.answers[NOUL_QUESTION_ID];
      const multiAnswer = result.answers[MULTI_CHOICE_QUESTION_ID];
      if (choiceAnswer && choiceAnswer.type !== "choice") throw new SystemOneError("invalid_schema", "choice 答案类型不符。", true);
      if (noulAnswer && noulAnswer.type !== "noul") throw new SystemOneError("invalid_schema", "noul 答案类型不符。", true);
      if (multiAnswer && multiAnswer.type !== "multi-choice") throw new SystemOneError("invalid_schema", "multi-choice 答案类型不符。", true);
      // selectedOptions 绝不只靠模型输出：每个选项都必须有已验证原文证据支持。
      // - 蚂蚁 multi-choice：无证据的选项剔除并记入 limitations/unlocalized。
      // - profile 无 multi-choice（如象信）：只接受题面声明、边界清晰且证据支持的
      //   A..Z 选项，从已验证证据中提取（如“A 和 J”可展示两个选项及证据）。
      // - 数值/单位题（无题面选项）不套选项，只保留证据。
      const selectedOptions: string[] = [];
      if (multiAnswer?.type === "multi-choice") {
        for (const choice of multiAnswer.choices) {
          if (evidenceSupportsOption(verified.evidence, choice)) {
            selectedOptions.push(choice);
          } else {
            limitations.push(`选项 ${choice} 仅有模型选择、缺少已验证原文证据支持，未纳入 selectedOptions。`);
            verified.unlocalized.push({ quote: choice, providerPath: "", reason: "模型选择的题面选项缺少已验证原文证据支持，不展示为已选" });
          }
        }
      } else if (stemOptions.length) {
        const derived = stemOptions.filter((label) => evidenceSupportsOption(verified.evidence, label));
        if (derived.length) {
          selectedOptions.push(...derived);
          limitations.push(`profile ${profile.id} 无 multi-choice 能力；selectedOptions 由已验证原文证据中提取（${derived.join("、")}），逐项需对照证据人工确认。`);
        }
      }
      record = DecisionAssistanceRecordSchema.parse({
        ...base,
        status: "completed",
        actualModel: result.model,
        choice: choiceAnswer?.type === "choice" ? (choiceAnswer.choice as DecisionAssistanceRecord["choice"]) : null,
        noul: noulAnswer?.type === "noul" ? noulAnswer.value : null,
        probabilities: choiceAnswer?.type === "choice" ? choiceAnswer.probabilities : null,
        confidence: choiceAnswer?.type === "choice" ? choiceAnswer.confidence : null,
        selectedOptions,
        evidence: verified.evidence,
        unlocalizedEvidence: verified.unlocalized,
        usage: result.usage,
        requestId: result.requestId,
        latencyMs: result.latencyMs,
        providerModelMs: result.providerModelMs,
        providerTotalMs: result.providerTotalMs,
        warnings: result.warnings,
        rawSafeResponse: result.raw,
      });
    } catch (error) {
      const e = error as Error;
      const isUnknown = e instanceof SystemOneError && e.outcomeUnknown;
      record = DecisionAssistanceRecordSchema.parse({
        ...base,
        status: isUnknown ? "outcome_unknown" : "failed",
        error: {
          code: e instanceof SystemOneError ? e.code : "internal_error",
          message: e.message,
          outcomeUnknown: isUnknown,
          ...(e instanceof SystemOneError && e.httpStatus !== undefined ? { httpStatus: e.httpStatus } : {}),
        },
      });
    }

    // 保存前再次核对材料：题目、答卷、评分或已有评分变化 → 不保存为可消费结果。
    const latest = await loadValidAnswers(this.runsRoot, runId, this.datasetDir, this.datasetId, mode);
    const latestTrial = latest.trials.find((t) => t.trialId === trialId);
    const latestLoc = latest.locations.get(trialId);
    const latestGrade = latest.grades.find((g) => g.trialId === trialId);
    if (!latestTrial || !latestLoc || latestLoc.runId !== loc.runId || latestLoc.trialId !== loc.trialId ||
        materialDigest(latestTrial, latest.questions.get(trial.questionId), latest.scorings.get(trial.questionId), latestGrade) !== digest) {
      throw new Error("决策辅助期间题目、答卷或评分已变化，结果未保存；请重新检查材料后再发起。");
    }
    const dir = this.trialDir(loc.runId, loc.trialId);
    appendJsonl(pathJoin(dir, "decision-reviews.jsonl"), record);
    writeJsonAtomic(pathJoin(dir, "decision-review.json"), record);
    return record;
  }
}
