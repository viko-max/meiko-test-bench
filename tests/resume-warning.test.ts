import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countCompletedOtherConfig } from "../src/runner/archive.js";
import { TrialSchema } from "../src/shared/contracts.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function putCompleted(runsRoot: string, dir: string, configDigest: string, qid: string): void {
  const td = join(runsRoot, dir, "trials", `${qid}__without_tool__x__0`);
  mkdirSync(td, { recursive: true });
  writeFileSync(
    join(td, "trial.json"),
    JSON.stringify(
      TrialSchema.parse({
        trialId: `${qid}__without_tool__x__0`,
        datasetId: "demo",
        datasetVersion: "1",
        questionId: qid,
        questionVersion: "1",
        provider: "longcat",
        modelId: "M",
        mode: "without_tool",
        configDigest,
        promptVersion: "v1",
        toolsVersion: "v1",
        executionStatus: "completed",
        finalAnswerSheet: "x",
      }),
    ),
  );
}

describe("resume re-bill guard: completed trials under a DIFFERENT config", () => {
  it("counts completed trials whose config differs (the silent re-bill footgun)", () => {
    const runsRoot = tmp("pi-warn-");
    putCompleted(runsRoot, "runA", "digestA", "q1");
    putCompleted(runsRoot, "runA", "digestA", "q2");
    expect(countCompletedOtherConfig(runsRoot, "without_tool", "longcat", "M", "digestB")).toBe(2);
    expect(countCompletedOtherConfig(runsRoot, "without_tool", "longcat", "M", "digestA")).toBe(0);
    // A different model is a different identity, not counted here.
    expect(countCompletedOtherConfig(runsRoot, "without_tool", "longcat", "OTHER", "digestB")).toBe(0);
  });
});
