/**
 * P1-4: source selection for offline re-grading. Given EXPLICIT run dirs (or a
 * scanned set), collect every attempt per question, verify they share ONE full run
 * identity (provider|modelId|configDigest|datasetVersion), and choose
 * deterministically — preferring a COMPLETED attempt. Duplicates are NOT silently
 * resolved: without `allowDuplicates` a question with 2+ completed attempts is left
 * unchosen and reported as a conflict requiring an explicit decision. An answer
 * with NO content digest is blocked (never graded on unconfirmable content).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TrialSchema, type AnswerMode, type Trial } from "../shared/contracts.js";

export interface RegradeAttempt {
  trial: Trial;
  dir: string;
  trialId: string;
}

export interface RegradeSelection {
  /** One chosen attempt per questionId (prefer completed; deterministic order). */
  chosen: Map<string, RegradeAttempt>;
  /** Duplicate-completed conflicts (only auto-resolved when allowDuplicates). */
  conflicts: string[];
  /** Distinct FULL run identities seen (provider|modelId|configDigest|datasetVersion). */
  identities: string[];
  /** Questions blocked from grading (e.g. no content digest). */
  blocked: Array<{ questionId: string; reason: string }>;
}

export interface SelectOptions {
  /** Explicitly permit auto-choosing among duplicate completed attempts. */
  allowDuplicates?: boolean;
}

function identityOf(t: Trial): string {
  return `${t.provider}|${t.modelId}|${t.configDigest}|${t.datasetVersion}`;
}

/** Read every trial.json under runsRoot/<dir>/trials for the given mode. */
function readAttempts(runsRoot: string, dir: string, mode: AnswerMode): RegradeAttempt[] {
  const trialsDir = join(runsRoot, dir, "trials");
  if (!existsSync(trialsDir)) return [];
  const out: RegradeAttempt[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(trialsDir).sort();
  } catch {
    return out;
  }
  for (const t of names) {
    const tp = join(trialsDir, t, "trial.json");
    if (!existsSync(tp)) continue;
    try {
      const trial = TrialSchema.parse(JSON.parse(readFileSync(tp, "utf8")));
      if (trial.mode !== mode) continue;
      out.push({ trial, dir, trialId: t });
    } catch {
      /* ignore unreadable */
    }
  }
  return out;
}

export function selectRegradeSources(runsRoot: string, sourceDirs: string[], mode: AnswerMode, opts: SelectOptions = {}): RegradeSelection {
  const perQuestion = new Map<string, RegradeAttempt[]>();
  const identities = new Set<string>();
  for (const dir of [...sourceDirs].sort()) {
    for (const a of readAttempts(runsRoot, dir, mode)) {
      const arr = perQuestion.get(a.trial.questionId) ?? [];
      arr.push(a);
      perQuestion.set(a.trial.questionId, arr);
      identities.add(identityOf(a.trial));
    }
  }

  const chosen = new Map<string, RegradeAttempt>();
  const conflicts: string[] = [];
  const blocked: Array<{ questionId: string; reason: string }> = [];
  for (const [qid, arr] of [...perQuestion.entries()].sort()) {
    const completed = arr.filter((a) => a.trial.executionStatus === "completed");
    if (completed.length > 1) {
      conflicts.push(`${qid}: ${completed.length} completed attempts across ${[...new Set(completed.map((c) => c.dir))].join(", ")} — duplicate billing? resolve explicitly`);
      // P1-4: do NOT silently auto-pick; require an explicit --allow-duplicates.
      if (!opts.allowDuplicates) continue;
    }
    // Deterministic: prefer the first COMPLETED attempt by sorted run-dir/trial.
    const pick = completed[0] ?? arr[0];
    if (!pick) continue;
    if (!pick.trial.questionContentDigest) {
      blocked.push({ questionId: qid, reason: "archived answer has no content digest — cannot confirm it matches the current question" });
      continue;
    }
    chosen.set(qid, pick);
    identities.add(identityOf(pick.trial));
  }
  return { chosen, conflicts, identities: [...identities], blocked };
}
