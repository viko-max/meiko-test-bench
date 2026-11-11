/**
 * Human review queue (R4-2; AGENTS.md §8/§14). Identifies the trials a human
 * MUST look at before they count: answers that are pending_human_review
 * (non-deterministic, not yet scored) or only model_preliminary (a grader model
 * proposed a score that is NOT yet confirmed). Deterministic rule_graded and
 * human_confirmed trials are done; non-answerable trials are excluded. This is
 * the pure core of the TUI grading page — the interactive alternate-screen UI is
 * built separately (Windows visual check, v0.2 §14).
 */
import type { Grade, Trial } from "../shared/contracts.js";

export interface ReviewItem {
  trial: Trial;
  grade?: Grade;
  reason: string;
}

export function reviewQueue(trials: Trial[], grades: Grade[]): ReviewItem[] {
  const byTrial = new Map(grades.map((g) => [g.trialId, g]));
  const out: ReviewItem[] = [];
  for (const t of trials) {
    if (t.executionStatus !== "completed" || !t.finalAnswerSheet) continue; // not answerable
    const g = byTrial.get(t.trialId);
    if (!g) {
      out.push({ trial: t, reason: "ungraded" });
      continue;
    }
    if (g.reviewStatus === "pending_human_review") out.push({ trial: t, grade: g, reason: g.reviewReason ?? "pending_human_review" });
    else if (g.reviewStatus === "model_preliminary") out.push({ trial: t, grade: g, reason: "model_preliminary (awaiting confirmation)" });
    // rule_graded / human_confirmed -> final, not queued
  }
  return out;
}
