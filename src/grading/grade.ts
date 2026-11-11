/**
 * Grade dispatch + Grade construction (AGENTS.md §8). Deterministic for
 * objective kinds; open/expression stay pending_human_review (v1 makes no claim
 * of symbolic/structure equivalence). Unscored or non-completed trials are not
 * graded and not silently zeroed. Re-grading reads only archived answer sheets.
 */
import { GradeSchema, type Grade, type PublicQuestion, type ScoringSpec, type Trial } from "../shared/contracts.js";
import { shortDigest } from "../shared/hashing.js";
import { gradeObjective, OBJECTIVE_GRADER_VERSION } from "./objective.js";
import { assertScoring, scoringDigest } from "./scoring.js";

export interface GradeTrialResult {
  grade?: Grade;
  skipped?: string;
}

// 旧记录缺少摘要时不能证明依据未变化；保留历史，但不自动计入当前成绩。
export function gradeIsStale(grade: Grade, scoring: ScoringSpec): boolean {
  return grade.questionId !== scoring.questionId || grade.scoringVersion !== scoring.scoringVersion ||
    grade.scoringDigest !== scoringDigest(scoring) || grade.maxScore !== scoring.maxScore ||
    !Number.isFinite(grade.rawScore) || grade.rawScore < 0 || grade.rawScore > scoring.maxScore;
}

/** Offline regrade applies ONLY when the archived answer's question version
 *  matches the current scoring's question version (P1-C) — never grade an
 *  old-version answer under a new standard. */
export function regradeApplicable(trial: Trial, scoring: ScoringSpec): boolean {
  return scoring.questionId === trial.questionId && scoring.questionVersion === trial.questionVersion;
}

export function gradeTrial(trial: Trial, question?: PublicQuestion, scoring?: ScoringSpec, now?: string): GradeTrialResult {
  if (!scoring) return { skipped: "unscored: no scoring spec (not counted toward formal score)" };
  if (!question) return { skipped: "no public question" };
  assertScoring(scoring, question);
  if (trial.truncated) return { skipped: "truncated (incomplete submission) — not auto-confirmed" };
  if (trial.executionStatus !== "completed" || !trial.finalAnswerSheet) {
    return { skipped: `not gradable: execution ${trial.executionStatus}` };
  }
  const res = gradeObjective(question, scoring, trial.finalAnswerSheet);
  const grade = GradeSchema.parse({
    gradeId: `${trial.trialId}__${scoring.scoringVersion}__${res.reviewStatus}__${shortDigest({ t: trial.trialId, scoring, rs: res.reviewStatus, raw: res.rawScore, version: OBJECTIVE_GRADER_VERSION, evidence: res.evidence })}`,
    trialId: trial.trialId,
    questionId: question.id,
    scoringVersion: scoring.scoringVersion,
    scoringDigest: scoringDigest(scoring),
    graderKind: "rule",
    rawScore: res.rawScore,
    maxScore: res.maxScore,
    items: res.items,
    reviewStatus: res.reviewStatus,
    ...(res.reviewStatus === "pending_human_review" ? { reviewReason: res.evidence } : {}),
    createdAt: now ?? new Date().toISOString(),
  });
  return { grade };
}
