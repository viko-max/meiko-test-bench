/**
 * Convert a subset of the sibling science_bench dev set into this project's
 * question contract (AGENTS.md §2/§5; v0.2 §3 "explicit import"). READ-ONLY on
 * science_bench; writes Markdown stems + independent scoring JSON here.
 *
 * Selects TEXT, deterministically-gradable items (single_choice / numeric_with_unit)
 * with requires_figure=false — image items are skipped because image input is not
 * yet verified. The imported set is for FRAMEWORK validation, not a formal
 * benchmark; science_bench source licensing still restricts public redistribution.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { PublicQuestionSchema, ScoringSpecSchema, assertPublicAssetsClean, type AnswerKind } from "../shared/contracts.js";

/** science_bench answer_kind -> this project's AnswerKind. */
const KIND_MAP: Record<string, AnswerKind> = {
  single_choice: "single_choice",
  multiple_choice: "multi_choice",
  multi_blank: "multi_blank",
  numeric_with_unit: "numeric_unit",
  math_expression: "expression",
  explanation: "open",
  multi_part: "open",
};

const SELECTABLE = new Set(["single_choice", "numeric_with_unit"]);

/**
 * Deterministic repair of a science_bench ingestion artifact: LaTeX commands
 * whose leading letter is a C/Python escape (\a \b \f \v) were collapsed to the
 * raw control char (e.g. \frac -> U+000C + "rac", \alpha -> U+0007 + "lpha").
 * Those control chars have no legitimate meaning in LaTeX, so restoring the
 * backslash is unambiguous and deterministic (not a guess). Applied to stem +
 * option text; the number of repairs is logged for audit (AGENTS.md: no silent
 * rewrite -- every repair is counted and reported).
 */
const LATEX_ESCAPE_REPAIR: Array<[RegExp, string]> = [
  [/\u0007/g, "\\a"],
  [/\u0008/g, "\\b"],
  [/\u000b/g, "\\v"],
  [/\u000c/g, "\\f"],
];
function repairLatex(text: string): { text: string; repairs: number } {
  let out = text;
  let repairs = 0;
  for (const [re, rep] of LATEX_ESCAPE_REPAIR) {
    const m = out.match(re);
    if (m) repairs += m.length;
    out = out.replace(re, rep);
  }
  return { text: out, repairs };
}

export interface ConvertOptions {
  scienceBenchRoot: string;
  outDir: string;
  limit: number;
}

export interface ConvertResult {
  written: number;
  skipped: number;
  ids: string[];
  notes: string[];
}

export function convertScienceBenchDev(opts: ConvertOptions): ConvertResult {
  const manifestPath = join(opts.scienceBenchRoot, "data", "manifests", "dev@2.json");
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    entries: Array<{ item_id: string; item_version: string; answer_kind: string; requires_figure: boolean | null; excluded: boolean }>;
  };

  const publicDir = join(opts.outDir, "public");
  const scoringDir = join(opts.outDir, "scoring");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(scoringDir, { recursive: true });

  const candidates = manifest.entries.filter(
    (e) => !e.excluded && e.requires_figure === false && SELECTABLE.has(e.answer_kind),
  );

  const ids: string[] = [];
  const notes: string[] = [];
  let written = 0;
  let skipped = 0;
  let latexRepairs = 0;

  for (const entry of candidates) {
    if (written >= opts.limit) break;
    const pubFile = join(opts.scienceBenchRoot, "data", "items", "public", `${entry.item_id}@${entry.item_version}.json`);
    const scoFile = join(opts.scienceBenchRoot, "data", "items", "scoring", `${entry.item_id}@${entry.item_version}.json`);
    if (!existsSync(pubFile) || !existsSync(scoFile)) {
      skipped++;
      notes.push(`missing files for ${entry.item_id}`);
      continue;
    }
    const item = JSON.parse(readFileSync(pubFile, "utf8"));
    const scoring = JSON.parse(readFileSync(scoFile, "utf8"));

    const kind = KIND_MAP[entry.answer_kind];
    if (!kind) {
      skipped++;
      continue;
    }

    // Build options map from science_bench list [{label,text}] (choice kinds).
    let options: Record<string, string> | undefined;
    if (Array.isArray(item.options)) {
      options = {};
      for (const o of item.options) {
        if (o && typeof o.label === "string") {
          const r = repairLatex(String(o.text ?? ""));
          latexRepairs += r.repairs;
          options[o.label] = r.text;
        }
      }
    }

    const fm: Record<string, unknown> = {
      id: entry.item_id,
      version: String(entry.item_version),
      subject: String(item.subject ?? "unknown"),
      answer_kind: kind,
      language: String(item.language ?? "en"),
      tags: ["sciencebench-dev", entry.answer_kind],
    };
    if (options && Object.keys(options).length > 0) fm.options = options;

    const stemRep = repairLatex(String(item.stem ?? "").trim());
    latexRepairs += stemRep.repairs;
    const stem = stemRep.text;
    const md = `---\n${YAML.stringify(fm)}---\n\n${stem}\n`;
    const question = PublicQuestionSchema.parse({
      id: entry.item_id,
      version: String(entry.item_version),
      subject: String(item.subject ?? "unknown"),
      answerKind: kind,
      language: String(item.language ?? "en"),
      tags: ["sciencebench-dev", entry.answer_kind],
      stem,
      assets: [],
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    });
    assertPublicAssetsClean(question);

    const spec = ScoringSpecSchema.parse({
      questionId: entry.item_id,
      questionVersion: String(entry.item_version),
      scoringVersion: String(scoring.scoring_version ?? "1"),
      answerKind: kind,
      maxScore: Number(scoring.max_score ?? 1),
      reference: scoring.answer !== undefined && scoring.answer !== null ? String(scoring.answer) : undefined,
      tolerance: typeof scoring.tolerance === "number" ? scoring.tolerance : undefined,
      units: typeof scoring.unit === "string" && scoring.unit.length > 0 ? [scoring.unit] : [],
      deterministicLocked: SELECTABLE.has(entry.answer_kind),
    });

    writeFileSync(join(publicDir, `${entry.item_id}.md`), md, "utf8");
    writeFileSync(join(scoringDir, `${entry.item_id}.json`), JSON.stringify(spec, null, 2) + "\n", "utf8");
    ids.push(entry.item_id);
    written++;
  }

  // Provenance + license note (internal framework test; no public redistribution).
  writeFileSync(
    join(opts.outDir, "SOURCE-NOTE.md"),
    [
      "# sciencebench-dev (imported for framework validation)",
      "",
      `Imported ${written} text, deterministically-gradable items from science_bench data/manifests/dev@2.json`,
      "(single_choice / numeric_with_unit, requires_figure=false).",
      "",
      "- READ-ONLY source: ../science_bench (not modified).",
      "- For FRAMEWORK validation only, NOT a formal benchmark result.",
      "- science_bench source licensing restricts PUBLIC REDISTRIBUTION; keep internal.",
      "- Image-required items were skipped (image input not yet verified).",
      "",
    ].join("\n"),
    "utf8",
  );

  if (latexRepairs > 0) notes.push(`repaired ${latexRepairs} LaTeX backslash-escape control chars (science_bench ingestion artifact)`);

  return { written, skipped, ids, notes };
}
