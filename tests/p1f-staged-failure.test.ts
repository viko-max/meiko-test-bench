import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ProtectionLimitsSchema, PublicQuestionSchema, type RunSpec } from "../src/shared/contracts.js";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { runOneTrial } from "../src/runner/trial-service.js";

const question = PublicQuestionSchema.parse({ id: "phy-001", version: "1", subject: "physics", answerKind: "numeric_unit", stem: "Find F.", assets: [] });
function runSpec(): RunSpec {
  return { datasetId: "demo", datasetVersion: "1", questionId: "phy-001", questionVersion: "1", provider: "faux", modelId: "faux-1", mode: "without_tool", promptVersion: "v1", toolsVersion: "v1", limits: ProtectionLimitsSchema.parse({}) };
}
function fauxStream(answer: string): { streamFn: StreamFn; model: ReturnType<ReturnType<typeof fauxProvider>["getModel"]> } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(answer)]);
  return { streamFn: makeExamStreamFn(models), model: faux.getModel() };
}
const dirs: string[] = [];
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("P1-F failures are staged, not mislabeled as failed_unprocessed", () => {
  it("answer obtained but archive write failed -> REAL status + archiveError (not failed_unprocessed, stable trialId)", async () => {
    const { streamFn, model } = fauxStream("The net force is 6 N.");
    const res = await runOneTrial({
      runSpec: runSpec(), question, index: 0, streamFn, model, tools: [], toolsVersion: "v1", runsRoot: tmp("p1f-"), workRoot: tmp("p1f-"),
      persistTrial: () => {
        throw new Error("disk full");
      },
    });
    expect(res.trial.executionStatus).toBe("completed"); // the model DID answer
    expect(res.trial.finalAnswerSheet).toBe("The net force is 6 N.");
    expect(res.archiveError).toMatch(/disk full/);
    expect(res.trialId).toContain("phy-001"); // stable identity, not a fabricated one
  });

  it("a clean run returns no archiveError", async () => {
    const { streamFn, model } = fauxStream("The net force is 6 N.");
    const res = await runOneTrial({ runSpec: runSpec(), question, index: 0, streamFn, model, tools: [], toolsVersion: "v1", runsRoot: tmp("p1f-"), workRoot: tmp("p1f-") });
    expect(res.trial.executionStatus).toBe("completed");
    expect(res.archiveError).toBeUndefined();
  });
});
