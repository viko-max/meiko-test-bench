/**
 * Offline re-grade (AGENTS.md §8/§12; v0.2 §12). Reads ONLY archived answer
 * sheets + the dataset, re-grades with the CURRENT deterministic graders, and
 * writes an updated report. Never re-answers (no model calls) — improving a
 * grader retroactively improves existing runs for free.
 *
 * P1-4/5: sources are EXPLICIT. Pass --run-ids "<runId1>,<runId2>" to pin exactly
 * which run dirs to read (a retry writes each attempt to its own dir, so a
 * logical run may span several). A bare --prefix scan still works but WARNS. The
 * selected sources MUST share one full run identity (provider|modelId|configDigest|
 * datasetVersion) — otherwise it REFUSES. Per question a COMPLETED attempt is
 * preferred; DUPLICATES are not auto-resolved (re-run with --allow-duplicates, or
 * resolve manually). An answer with no content digest, or whose content no longer
 * matches, is NOT graded. --write-grades updates the archived grade IN PLACE.
 *
 *   npx tsx scripts/regrade.ts --run-ids "<runId>" --mode without_tool --dataset datasets/demo
 *   npx tsx scripts/regrade.ts --run-ids "<a>,<b>" --mode with_tool --allow-duplicates --write-grades
 */
import { readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeGradeFile } from "../src/runner/archive.js";
import { selectRegradeSources } from "../src/runner/regrade-source.js";
import { importDataset } from "../src/dataset/import.js";
import { gradeTrial, regradeApplicable } from "../src/grading/grade.js";
import { buildModeReport, reportToMarkdown } from "../src/reporting/report.js";
import type { AnswerMode } from "../src/shared/contracts.js";
import type { Grade, PublicQuestion, ScoringSpec } from "../src/shared/contracts.js";

function arg(name: string, d?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : d;
}

const runsRoot = arg("--runs-root", "runs")!;
const prefix = arg("--prefix");
const runIdsArg = arg("--run-ids");
const mode = arg("--mode") as AnswerMode;
const datasetDir = arg("--dataset", "datasets/demo")!;

const imported = await importDataset({ datasetId: "re", publicDir: join(datasetDir, "public"), scoringDir: join(datasetDir, "scoring") });
const questions = new Map<string, PublicQuestion>();
const scorings = new Map<string, ScoringSpec>();
const contentDigests = new Map<string, string | undefined>();
for (const e of imported.entries) {
  if (e.question) questions.set(e.questionId, e.question);
  if (e.scoring) scorings.set(e.questionId, e.scoring);
  if (e.question) contentDigests.set(e.questionId, e.contentDigest);
}
const plannedMax = [...scorings.values()].reduce((a, s) => a + s.maxScore, 0);

// P1-4/5: explicit sources preferred; a wide --prefix scan warns.
let sourceDirs: string[];
if (runIdsArg) {
  sourceDirs = runIdsArg.split(",").map((s) => s.trim()).filter(Boolean);
} else if (prefix) {
  sourceDirs = readdirSync(runsRoot).filter((d) => d.startsWith(prefix));
  console.log(`WARNING: no --run-ids given; scanning prefix "${prefix}" (${sourceDirs.length} dirs). Pass --run-ids "<a>,<b>" to pin exact sources and avoid mixing prior/duplicate runs.`);
} else {
  console.error("ERROR: pass --run-ids \"<runId1>,<runId2>\" (preferred) or --prefix \"<baseRunId>\".");
  process.exit(2);
}
for (const d of sourceDirs) {
  if (!existsSync(join(runsRoot, d, "trials"))) console.log(`WARNING: source run dir has no trials/: ${d}`);
}

const allowDuplicates = process.argv.includes("--allow-duplicates");
const { chosen, conflicts, identities, blocked } = selectRegradeSources(runsRoot, sourceDirs, mode, { allowDuplicates });
if (identities.length > 1) {
  console.error(`REFUSED: sources span multiple run identities (provider|modelId|configDigest|datasetVersion):\n  ${identities.join("\n  ")}\nPin --run-ids to ONE run, or split by identity.`);
  process.exit(2);
}
if (conflicts.length > 0) {
  console.log(`CONFLICT: ${conflicts.length} question(s) have MULTIPLE completed attempts; NOT auto-graded. Re-run with --allow-duplicates (grades first-by-dir) or resolve manually:`);
  for (const c of conflicts) console.log("  " + c);
}
if (blocked.length > 0) {
  console.log(`BLOCKED: ${blocked.length} answer(s) lack a content digest (cannot confirm they match the current question) — not graded:`);
  for (const b of blocked) console.log(`  ${b.questionId}: ${b.reason}`);
}

const writeGrades = process.argv.includes("--write-grades");
const trials = [...chosen.values()].map((v) => v.trial);
const grades: Grade[] = [];
let skipped = 0;
for (const { trial, dir, trialId } of chosen.values()) {
  const scoring = scorings.get(trial.questionId);
  // P1-C: only re-grade an archived answer whose question version matches the
  // current scoring — never grade an old-version answer under a new standard.
  if (!scoring || !regradeApplicable(trial, scoring)) {
    skipped++;
    continue;
  }
  // P1-4: the content digest must still match — do not grade an answer whose
  // underlying question content changed (missing digest already blocked above).
  const curDigest = contentDigests.get(trial.questionId);
  if (trial.questionContentDigest && curDigest && trial.questionContentDigest !== curDigest) {
    skipped++;
    continue;
  }
  const g = gradeTrial(trial, questions.get(trial.questionId), scoring);
  if (g.grade) {
    grades.push(g.grade);
    if (writeGrades) {
      writeGradeFile(runsRoot, dir, trialId, g.grade);
    }
  }
}

const report = buildModeReport({ mode, trials, grades, questions, scorings, plannedMaxScore: plannedMax, plannedQuestionIds: [...questions.keys()] });
const outDir = join(runsRoot, `${(runIdsArg ? sourceDirs[0] : prefix) ?? "regrade"}__regraded-${mode}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.md"), reportToMarkdown(report), "utf8");
const t = report.totals;
console.log(
  `REGRADED ${mode}: ${trials.length} chosen trial(s) from ${sourceDirs.length} source dir(s) | confirmed ${t.confirmedRaw}/${t.confirmedMax} (plannedMax ${t.plannedMax})` +
    `${skipped ? ` | ${skipped} skipped (version/digest mismatch)` : ""}\ncoverage: ${JSON.stringify(report.coverage)}\n-> ${join(outDir, "report.md")}`,
);
