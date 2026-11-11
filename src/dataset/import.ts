/**
 * Dataset import + validation (AGENTS.md §2/§5; v0.2 §7.3). Reads Markdown stems
 * (public) and independent scoring JSON, builds PublicQuestion + ScoringSpec,
 * and runs the checks that gate a frozen run: format, id uniqueness, attachment
 * existence, image decodability, sub-question correspondence, and scoring
 * point consistency. Ambiguous / broken entries are blocked with reasons; they
 * are never silently repaired or auto-rewritten.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  PublicQuestionSchema,
  PublicAssetSchema,
  assertPublicAssetsClean,
  ScoringSpecSchema,
  type PublicAsset,
  type PublicQuestion,
  type ScoringSpec,
} from "../shared/contracts.js";
import { sha256OfText } from "../shared/hashing.js";
import { mediaTypeForRef, parseOptionsFromBody, parseQuestionMarkdown } from "./parse.js";
import { resolvePublicAttachment } from "../tools/paths.js";
import { assertScoring } from "../grading/scoring.js";

export interface ImportedEntry {
  questionId: string;
  question?: PublicQuestion;
  scoring?: ScoringSpec;
  errors: string[];
  warnings: string[];
  contentDigest?: string;
}

export interface ImportResult {
  datasetId: string;
  entries: ImportedEntry[];
  ok: boolean;
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext) && statSync(join(dir, f)).isFile())
    .sort();
}

function buildQuestion(md: string): { question?: PublicQuestion; assets: PublicAsset[]; errors: string[] } {
  const parsed = parseQuestionMarkdown(md);
  const fm = parsed.frontmatter;
  const errors: string[] = [];
  const assets: PublicAsset[] = [];
  if (fm.assets !== undefined) {
    const metadata = PublicAssetSchema.array().safeParse(fm.assets);
    if (!metadata.success) errors.push(`invalid asset metadata: ${metadata.error.message}`);
    else assets.push(...metadata.data);
  }

  for (const ir of parsed.imageRefs) {
    const mt = mediaTypeForRef(ir.ref);
    if (!mt) {
      errors.push(`unknown image type: ${ir.ref}`);
      continue;
    }
    if (!assets.some((asset) => asset.ref === ir.ref)) assets.push({ ref: ir.ref, mediaType: mt, role: "figure", ...(ir.alt ? { alt: ir.alt } : {}) });
  }

  const bodyOptions = parseOptionsFromBody(parsed.body);
  const options =
    (fm.options as Record<string, string> | undefined) ??
    (Object.keys(bodyOptions).length >= 2 ? bodyOptions : undefined);

  const input = {
    id: fm.id,
    version: fm.version,
    subject: fm.subject,
    answerKind: fm.answer_kind,
    language: fm.language,
    tags: fm.tags,
    options,
    parts: fm.parts,
    stem: parsed.body.trim(),
    assets,
  };
  const result = PublicQuestionSchema.safeParse(input);
  if (!result.success) {
    errors.push(`invalid public question: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { assets, errors };
  }
  try { assertPublicAssetsClean(result.data); } catch (error) { errors.push((error as Error).message); }
  return { question: result.data, assets, errors };
}

function validateAttachments(question: PublicQuestion, publicDir: string): string[] {
  const errors: string[] = [];
  for (const a of question.assets) {
    let path: string;
    try {
      path = resolvePublicAttachment(publicDir, a.ref);
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    if (!existsSync(path)) {
      errors.push(`missing attachment: ${a.ref}`);
    }
  }
  return errors;
}

/** Async image decodability check (sharp reads the real header). */
export async function validateImagesDecodable(question: PublicQuestion, publicDir: string): Promise<string[]> {
  const errors: string[] = [];
  for (const a of question.assets) {
    if (!a.mediaType.startsWith("image/")) continue;
    let path: string;
    try {
      path = resolvePublicAttachment(publicDir, a.ref);
    } catch {
      continue; // already reported by validateAttachments
    }
    if (!existsSync(path)) continue;
    try {
      const meta = await sharp(path).metadata();
      if (!meta.width || !meta.height) errors.push(`undecodable image: ${a.ref}`);
    } catch (e) {
      errors.push(`undecodable image ${a.ref}: ${(e as Error).message}`);
    }
  }
  return errors;
}

function validateScoring(question: PublicQuestion, scoring: ScoringSpec): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  try { assertScoring(scoring, question); }
  catch (error) { errors.push((error as Error).message); }
  return { errors, warnings };
}

export async function importDataset(opts: { datasetId: string; publicDir: string; scoringDir: string }): Promise<ImportResult> {
  const { datasetId, publicDir, scoringDir } = opts;

  // Load scoring specs by questionId.
  const scoringById = new Map<string, { spec: ScoringSpec; errors: string[] }>();
  for (const f of listFiles(scoringDir, ".json")) {
    try {
      const spec = ScoringSpecSchema.parse(JSON.parse(readFileSync(join(scoringDir, f), "utf8")));
      if (scoringById.has(spec.questionId)) {
        scoringById.get(spec.questionId)!.errors.push(`duplicate scoring questionId: ${spec.questionId}`);
        throw new Error(`duplicate scoring questionId: ${spec.questionId}`);
      }
      scoringById.set(spec.questionId, { spec, errors: [] });
    } catch (e) {
      scoringById.set(`__file__:${f}`, { spec: undefined as never, errors: [`scoring file ${f}: ${(e as Error).message}`] });
    }
  }

  const entries: ImportedEntry[] = [];
  const seenIds = new Set<string>();

  for (const f of listFiles(publicDir, ".md")) {
    const md = readFileSync(join(publicDir, f), "utf8");
    const built = buildQuestion(md);
    const errors = [...built.errors];
    const warnings: string[] = [];

    if (!built.question) {
      entries.push({ questionId: f, errors, warnings });
      continue;
    }
    const question = built.question;

    if (seenIds.has(question.id)) {
      errors.push(`duplicate question id: ${question.id}`);
    }
    seenIds.add(question.id);

    errors.push(...validateAttachments(question, publicDir));
    errors.push(...(await validateImagesDecodable(question, publicDir)));

    const scoring = scoringById.get(question.id);
    let scoringSpec: ScoringSpec | undefined;
    if (scoring?.spec) {
      errors.push(...scoring.errors);
      const sc = validateScoring(question, scoring.spec);
      errors.push(...sc.errors);
      warnings.push(...sc.warnings);
      scoringSpec = scoring.spec;
    } else {
      warnings.push("unscored: no scoring spec (may run but not counted toward formal score)");
    }

    // P1-1b: content digest covers the stem AND attachment bytes, so an attachment
    // swap at the same question version is detected on resume (no stale reuse).
    const attachParts: string[] = [];
    for (const a of question.assets) {
      try {
        attachParts.push(`${a.ref}:${sha256OfText(readFileSync(resolvePublicAttachment(publicDir, a.ref)).toString("base64"))}`);
      } catch (e) {
        errors.push(`attachment digest failed ${a.ref}: ${(e as Error).message}`);
      }
    }
    const contentDigest = sha256OfText(`${md}\n#attachments\n${attachParts.join("\n")}`);
    entries.push({ questionId: question.id, question, scoring: scoringSpec, errors, warnings, contentDigest });
  }

  // Surface scoring files that failed to parse or had no matching question.
  for (const [key, val] of scoringById) {
    if (key.startsWith("__file__:")) {
      entries.push({ questionId: key, errors: val.errors, warnings: [] });
    }
  }

  return { datasetId, entries, ok: entries.every((e) => e.errors.length === 0) };
}
