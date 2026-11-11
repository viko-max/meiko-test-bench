import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ProtectionLimitsSchema, PublicQuestionSchema, type PublicQuestion, type RunSpec } from "../src/shared/contracts.js";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { runOneTrial } from "../src/runner/trial-service.js";
import { classifyResume } from "../src/runner/resume.js";

const question = PublicQuestionSchema.parse({
  id: "phy-001",
  version: "1",
  subject: "physics",
  answerKind: "numeric_unit",
  stem: "Find the net force on a 2 kg block accelerating at 3 m/s^2.",
  assets: [],
});

function runSpec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    datasetId: "demo",
    datasetVersion: "1",
    questionId: question.id,
    questionVersion: question.version,
    provider: "faux",
    modelId: "faux-1",
    mode: "without_tool",
    promptVersion: "v1",
    toolsVersion: "v1",
    limits: ProtectionLimitsSchema.parse({}),
    ...over,
  };
}

function fauxStream(responses: string[]): { streamFn: StreamFn; model: ReturnType<ReturnType<typeof fauxProvider>["getModel"]> } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses.map((r) => fauxAssistantMessage(r)));
  return { streamFn: makeExamStreamFn(models), model: faux.getModel() };
}

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("trial service: orchestrate, isolate, persist", () => {
  it("persists a completed Trial + events and creates an isolated .work dir", async () => {
    const runsRoot = tmp("pi-runs-");
    const workRoot = tmp("pi-work-");
    const { streamFn, model } = fauxStream(["The net force is 6 N."]);

    const { trial, runId, trialId, workDir } = await runOneTrial({
      runSpec: runSpec(),
      question,
      index: 0,
      streamFn,
      model,
      tools: [],
      toolsVersion: "v1",
      runsRoot,
      workRoot,
    });

    expect(trial.executionStatus).toBe("completed");
    expect(trial.finalAnswerSheet).toBe("The net force is 6 N.");
    expect(trial.mode).toBe("without_tool");
    expect(runId).toContain("demo@1");
    expect(trialId.startsWith("phy-001__without_tool__")).toBe(true);

    // Durable artifacts exist.
    expect(existsSync(workDir)).toBe(true);
    const trialJson = JSON.parse(readFileSync(join(runsRoot, runId, "trials", trialId, "trial.json"), "utf8"));
    expect(trialJson.finalAnswerSheet).toBe("The net force is 6 N.");
    expect(existsSync(join(runsRoot, runId, "trials", trialId, "events.jsonl"))).toBe(true);
  });

  it("gives each question its own trialId and .work dir (session isolation)", async () => {
    const runsRoot = tmp("pi-runs-");
    const workRoot = tmp("pi-work-");
    const q2 = PublicQuestionSchema.parse({ ...question, id: "phy-002" });

    const a = fauxStream(["ans A"]);
    const r1 = await runOneTrial({ runSpec: runSpec(), question, index: 0, streamFn: a.streamFn, model: a.model, tools: [], toolsVersion: "v1", runsRoot, workRoot });
    const b = fauxStream(["ans B"]);
    const r2 = await runOneTrial({ runSpec: runSpec({ questionId: "phy-002" }), question: q2, index: 1, streamFn: b.streamFn, model: b.model, tools: [], toolsVersion: "v1", runsRoot, workRoot });

    expect(r1.trialId).not.toBe(r2.trialId);
    expect(r1.workDir).not.toBe(r2.workDir);
    expect(r1.runId).toBe(r2.runId); // same run identity
  });

  it("classifies resume by identity: skip completed, decide on interrupted/unknown, run on new", () => {
    const runsRoot = tmp("pi-runs-");
    // Reuse a completed trial id from a quick run is overkill; synthesize trials.
    const completed = { trialId: "T-done", executionStatus: "completed" } as never;
    const interrupted = { trialId: "T-int", executionStatus: "interrupted" } as never;
    const decisions = classifyResume([completed, interrupted], ["T-done", "T-int", "T-new"]);
    const byId = Object.fromEntries(decisions.map((d) => [d.trialId, d.action]));
    expect(byId["T-done"]).toBe("skip_completed");
    expect(byId["T-int"]).toBe("needs_decision");
    expect(byId["T-new"]).toBe("run");
    void runsRoot;
  });
});
