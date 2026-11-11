/**
 * Per-mode reporting (AGENTS.md §8/§10; v0.2 §13). Raw scores are summed
 * directly with original question weights — no per-question normalization, no
 * extra subject weighting, modes never merged. Only confirmed grades
 * (rule_graded / human_confirmed) count toward the confirmed total; model
 * preliminary, pending-review, unscored and failed records are shown but NOT
 * silently zeroed or dropped. Planned max is shown so incompleteness is visible.
 */
import type { AnswerKind, AnswerMode, ExecutionStatus, Grade, GradingStatus, PublicQuestion, ScoringSpec, Trial } from "../shared/contracts.js";
import { summarizeRequests, type MetricsSummary } from "../shared/metrics.js";
import { gradeIsStale } from "../grading/grade.js";

const CONFIRMED: ReadonlySet<GradingStatus> = new Set<GradingStatus>(["rule_graded", "human_confirmed"]);

export interface ReportInput {
  mode: AnswerMode;
  trials: Trial[];
  grades: Grade[];
  questions: Map<string, PublicQuestion>;
  scorings: Map<string, ScoringSpec>;
  plannedMaxScore: number;
  /** All planned question ids (P2-5b): every one must appear in the report, even
   *  if it never ran (e.g. scheduling stopped) — shown as pending, not dropped. */
  plannedQuestionIds?: string[];
}

export interface Bucket {
  raw: number;
  max: number;
  counted: number;
}

export interface PerQuestionRow {
  questionId: string;
  subject: string;
  answerKind: AnswerKind | "unknown";
  executionStatus: ExecutionStatus;
  gradingStatus: GradingStatus | "ungraded" | "unscored";
  rawScore?: number;
  maxScore?: number;
}

export interface ModeReport {
  mode: AnswerMode;
  totals: { confirmedRaw: number; confirmedMax: number; plannedMax: number };
  coverage: Record<string, number>;
  bySubject: Record<string, Bucket>;
  byAnswerKind: Record<string, Bucket>;
  perQuestion: PerQuestionRow[];
  metrics?: { recordedTrials: number; totalTrials: number; summary: MetricsSummary };
}

export function buildModeReport(input: ReportInput): ModeReport {
  const gradesByTrial = new Map(input.grades.map((g) => [g.trialId, g]));
  const trials = input.trials.filter((t) => t.mode === input.mode);

  const coverage: Record<string, number> = {};
  const bump = (k: string) => (coverage[k] = (coverage[k] ?? 0) + 1);

  const bySubject: Record<string, Bucket> = {};
  const byAnswerKind: Record<string, Bucket> = {};
  const perQuestion: PerQuestionRow[] = [];
  let confirmedRaw = 0;
  let confirmedMax = 0;

  const addBucket = (rec: Record<string, Bucket>, key: string, raw: number, max: number) => {
    const b = (rec[key] ??= { raw: 0, max: 0, counted: 0 });
    b.raw += raw;
    b.max += max;
    b.counted += 1;
  };

  for (const t of trials) {
    bump(`exec:${t.executionStatus}`);
    const q = input.questions.get(t.questionId);
    const s = input.scorings.get(t.questionId);
    const g = gradesByTrial.get(t.trialId);
    const gradeCurrent = !!g && !!s && !gradeIsStale(g, s);
    let gradingStatus: PerQuestionRow["gradingStatus"];
    if (g && gradeCurrent) {
      gradingStatus = g.reviewStatus;
      bump(`grade:${g.reviewStatus}`);
    } else if (g && !gradeCurrent) {
      gradingStatus = "pending_human_review"; // stale -> re-grade under the current basis
      bump("grade:stale");
    } else {
      gradingStatus = s ? "ungraded" : "unscored";
      bump(s ? "grade:ungraded" : "grade:unscored");
    }

    let rawScore: number | undefined;
    let maxScore: number | undefined;
    if (g && gradeCurrent && CONFIRMED.has(g.reviewStatus) && t.executionStatus === "completed") {
      rawScore = g.rawScore;
      maxScore = g.maxScore;
      confirmedRaw += g.rawScore;
      confirmedMax += g.maxScore;
      const subject = q?.subject ?? "unknown";
      const kind = q?.answerKind ?? "unknown";
      addBucket(bySubject, subject, g.rawScore, g.maxScore);
      addBucket(byAnswerKind, kind, g.rawScore, g.maxScore);
    } else if (s) {
      maxScore = s.maxScore; // show the max even when not yet confirmed
    }

    perQuestion.push({
      questionId: t.questionId,
      subject: q?.subject ?? "unknown",
      answerKind: q?.answerKind ?? "unknown",
      executionStatus: t.executionStatus,
      gradingStatus,
      ...(rawScore !== undefined ? { rawScore } : {}),
      ...(maxScore !== undefined ? { maxScore } : {}),
    });
  }

  // P2-5b: every planned question must appear; those that never ran (e.g. the
  // scheduler stopped) are shown as pending, not silently dropped.
  const ranQ = new Set(trials.map((t) => t.questionId));
  for (const qid of input.plannedQuestionIds ?? []) {
    if (ranQ.has(qid)) continue;
    const q = input.questions.get(qid);
    const s = input.scorings.get(qid);
    bump("exec:pending");
    bump("grade:unscored");
    perQuestion.push({
      questionId: qid,
      subject: q?.subject ?? "unknown",
      answerKind: q?.answerKind ?? "unknown",
      executionStatus: "pending",
      gradingStatus: "unscored",
      ...(s ? { maxScore: s.maxScore } : {}),
    });
  }

  return {
    mode: input.mode,
    totals: { confirmedRaw, confirmedMax, plannedMax: input.plannedMaxScore },
    coverage,
    bySubject,
    byAnswerKind,
    perQuestion,
    metrics: { recordedTrials: trials.filter((trial) => trial.metrics !== undefined).length, totalTrials: trials.length,
      summary: summarizeRequests(trials.flatMap((trial) => trial.metrics?.requests ?? [])) },
  };
}

export function reportToMarkdown(report: ModeReport): string {
  const lines: string[] = [];
  lines.push(`# Exam Report — mode: ${report.mode}`);
  lines.push("");
  lines.push(`- Confirmed score: **${report.totals.confirmedRaw} / ${report.totals.confirmedMax}** (raw sum, original weights)`);
  lines.push(`- Planned max (full dataset): ${report.totals.plannedMax}`);
  lines.push(`- Coverage: ${JSON.stringify(report.coverage)}`);
  if (report.metrics) {
    lines.push(`- Metrics coverage: ${report.metrics.recordedTrials}/${report.metrics.totalTrials} trials; missing values are null, partial sums include known requests only.`);
    lines.push("```json", JSON.stringify(report.metrics.summary, null, 2), "```");
  }
  lines.push("");
  lines.push("## By subject");
  for (const [k, b] of Object.entries(report.bySubject)) lines.push(`- ${k}: ${b.raw} / ${b.max} (${b.counted} counted)`);
  lines.push("");
  lines.push("## By answer kind");
  for (const [k, b] of Object.entries(report.byAnswerKind)) lines.push(`- ${k}: ${b.raw} / ${b.max} (${b.counted} counted)`);
  lines.push("");
  lines.push("## Per question");
  lines.push("| question | subject | kind | execution | grading | raw | max |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.perQuestion) {
    lines.push(`| ${r.questionId} | ${r.subject} | ${r.answerKind} | ${r.executionStatus} | ${r.gradingStatus} | ${r.rawScore ?? "-"} | ${r.maxScore ?? "-"} |`);
  }
  lines.push("");
  return lines.join("\n");
}
