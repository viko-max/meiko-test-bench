import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrialSchema } from "../src/shared/contracts.js";
import { selectRegradeSources } from "../src/runner/regrade-source.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

function writeTrial(dir: string, trialId: string, t: Record<string, unknown>): void {
  const d = join(root, dir, "trials", trialId);
  mkdirSync(d, { recursive: true });
  const trial = TrialSchema.parse({
    trialId,
    datasetId: "demo",
    datasetVersion: "1",
    questionId: "q1",
    questionVersion: "1",
    provider: "faux",
    modelId: "faux-1",
    mode: "without_tool",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:01:00Z",
    configDigest: "cfg1",
    promptVersion: "v1",
    toolsVersion: "v1",
    questionContentDigest: "digest-q1",
    ...t,
  });
  writeFileSync(join(d, "trial.json"), JSON.stringify(trial), "utf8");
}

describe("P1-4 selectRegradeSources (full identity, conflicts need explicit choice, block missing digest)", () => {
  it("does NOT auto-choose a duplicate-completed question without allowDuplicates", () => {
    root = mkdtempSync(join(tmpdir(), "pi-regrade-"));
    writeTrial("runA", "t1", { questionId: "q1", executionStatus: "completed" });
    writeTrial("runB", "t2", { questionId: "q1", executionStatus: "completed" });
    writeTrial("runC", "t3", { questionId: "q2", executionStatus: "completed" });
    const sel = selectRegradeSources(root, ["runA", "runB", "runC"], "without_tool");
    expect(sel.chosen.has("q1")).toBe(false); // duplicate -> NOT auto-graded
    expect(sel.conflicts.some((c) => c.startsWith("q1:"))).toBe(true);
    expect(sel.chosen.get("q2")?.dir).toBe("runC"); // unambiguous -> chosen
  });

  it("with allowDuplicates, chooses the first completed by sorted dir", () => {
    root = mkdtempSync(join(tmpdir(), "pi-regrade-"));
    writeTrial("runA", "t1", { questionId: "q1", executionStatus: "completed" });
    writeTrial("runB", "t2", { questionId: "q1", executionStatus: "completed" });
    const sel = selectRegradeSources(root, ["runA", "runB"], "without_tool", { allowDuplicates: true });
    expect(sel.chosen.get("q1")?.dir).toBe("runA");
  });

  it("prefers a completed attempt over a LATER non-completed one", () => {
    root = mkdtempSync(join(tmpdir(), "pi-regrade-"));
    writeTrial("runA", "t1", { questionId: "q1", executionStatus: "completed", endedAt: "2026-01-01T00:01:00Z" });
    writeTrial("runB", "t2", { questionId: "q1", executionStatus: "outcome_unknown", endedAt: "2026-01-01T09:00:00Z" });
    const sel = selectRegradeSources(root, ["runA", "runB"], "without_tool");
    expect(sel.chosen.get("q1")?.trial.executionStatus).toBe("completed");
    expect(sel.conflicts).toHaveLength(0);
  });

  it("blocks an answer with NO content digest (cannot confirm content)", () => {
    root = mkdtempSync(join(tmpdir(), "pi-regrade-"));
    writeTrial("runA", "t1", { questionId: "q1", executionStatus: "completed", questionContentDigest: undefined });
    const sel = selectRegradeSources(root, ["runA"], "without_tool");
    expect(sel.chosen.has("q1")).toBe(false);
    expect(sel.blocked.some((b) => b.questionId === "q1")).toBe(true);
  });

  it("reports distinct FULL identities (provider|modelId|configDigest|datasetVersion)", () => {
    root = mkdtempSync(join(tmpdir(), "pi-regrade-"));
    writeTrial("runA", "t1", { questionId: "q1", executionStatus: "completed", provider: "faux", modelId: "faux-1", configDigest: "cfg1" });
    writeTrial("runB", "t2", { questionId: "q2", executionStatus: "completed", provider: "other", modelId: "m2", configDigest: "cfg1" });
    const sel = selectRegradeSources(root, ["runA", "runB"], "without_tool");
    expect(sel.identities.length).toBe(2);
  });
});
