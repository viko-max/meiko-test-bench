import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadArchivedTrials } from "../src/runner/archive.js";
import { classifyArchived } from "../src/runner/resume.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function attempt(id: string, digest = "D"): Record<string, unknown> {
  return {
    trialId: id,
    runId: "runX",
    datasetId: "demo",
    datasetVersion: "1",
    questionId: id.split("__")[0],
    questionVersion: "1",
    provider: "longcat",
    modelId: "M",
    mode: "without_tool",
    configDigest: digest,
    promptVersion: "v1",
    toolsVersion: "v1",
    status: "dispatched",
    startedAt: "2026-10-10T00:00:00Z",
  };
}

describe("P1-1 mid-run archive state must NEVER cause a re-answer", () => {
  it("a PARTIAL/invalid trial.json WITH attempt.json -> outcome_unknown (not skipped/re-run)", () => {
    const runsRoot = tmp("p1-1-");
    const id = "q1__without_tool__x__0";
    const td = join(runsRoot, "runX", "trials", id);
    mkdirSync(td, { recursive: true });
    // What setAnswerSheet writes MID-RUN today: an incomplete trial.json.
    writeFileSync(join(td, "trial.json"), JSON.stringify({ trialId: id, answerSheet: "the answer" }));
    writeFileSync(join(td, "attempt.json"), JSON.stringify(attempt(id)));

    const map = loadArchivedTrials(runsRoot, "without_tool", "longcat", "M", "D");
    const a = map.get("q1@1");
    expect(a, "must NOT be skipped").toBeTruthy();
    expect(a?.hasAttempt).toBe(true);
    expect(a?.trial.executionStatus).toBe("outcome_unknown");
    expect(classifyArchived(a!.trial, a!.hasAttempt)).toBe("load_decision"); // never "run"
  });

  it("an invalid trial.json with NO attempt -> still skipped (never executed)", () => {
    const runsRoot = tmp("p1-1-");
    const id = "q2__without_tool__x__0";
    const td = join(runsRoot, "runX", "trials", id);
    mkdirSync(td, { recursive: true });
    writeFileSync(join(td, "trial.json"), JSON.stringify({ trialId: id, answerSheet: "x" })); // no attempt.json

    const map = loadArchivedTrials(runsRoot, "without_tool", "longcat", "M", "D");
    expect(map.get("q2@1")).toBeUndefined(); // nothing to resume; may run fresh
  });
});
