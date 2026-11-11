/**
 * Resume classification (AGENTS.md §7; v0.2 §11). trialId is derived from the
 * full run identity (dataset+question+model+mode+config+prompt+tools digests),
 * so matching by trialId IS identity matching — never by bare question id.
 * Completed trials are skipped; interrupted / outcome-unknown / limit-reached
 * trials are surfaced for an explicit user decision; only clearly-unexecuted
 * failures may auto-run again.
 */
import type { Trial } from "../shared/contracts.js";

export type ResumeAction = "run" | "skip_completed" | "needs_decision";

export interface ResumeDecision {
  trialId: string;
  action: ResumeAction;
  reason?: string;
}

const NEEDS_DECISION = new Set(["interrupted", "outcome_unknown", "limit_reached", "unsupported_input"]);

export function classifyResume(existing: Trial[], plannedTrialIds: string[]): ResumeDecision[] {
  const byId = new Map(existing.map((t) => [t.trialId, t]));
  return plannedTrialIds.map((trialId) => {
    const prev = byId.get(trialId);
    if (!prev) return { trialId, action: "run" };
    if (prev.executionStatus === "completed") return { trialId, action: "skip_completed", reason: "already completed" };
    if (prev.executionStatus === "failed_unprocessed")
      return { trialId, action: "run", reason: "retryable: previously failed_unprocessed" };
    if (NEEDS_DECISION.has(prev.executionStatus))
      return { trialId, action: "needs_decision", reason: `previous status ${prev.executionStatus}` };
    return { trialId, action: "needs_decision", reason: `previous status ${prev.executionStatus}` };
  });
}

/**
 * Archive-aware resume decision for ONE archived trial (batch resume, R1-3/5).
 *  - load_completed: no request needed — load the archive into the report.
 *  - load_decision : a request may have been billed / outcome unknown — surface
 *                    it but NEVER auto-resend (the user decides).
 *  - run           : clearly unexecuted (failed_unprocessed with NO attempt) —
 *                    safe to run again.
 * `hasAttempt` = an attempt.json exists (a model request was dispatched).
 */
export type ArchiveAction = "load_completed" | "load_decision" | "run";
export function classifyArchived(trial: Trial, hasAttempt: boolean): ArchiveAction {
  if (trial.executionStatus === "completed" || trial.executionStatus === "unsupported_input") return "load_completed";
  if (trial.executionStatus === "failed_unprocessed") return hasAttempt ? "load_decision" : "run";
  // interrupted / outcome_unknown / limit_reached: outcome is not cleanly known.
  return "load_decision";
}
