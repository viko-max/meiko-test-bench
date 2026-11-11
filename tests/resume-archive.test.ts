import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  ProtectionLimitsSchema,
  PublicQuestionSchema,
  ScoringSpecSchema,
  TrialSchema,
  type RunSpec,
  type Trial,
} from "../src/shared/contracts.js";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { runOneTrial } from "../src/runner/trial-service.js";
import { gradeTrial } from "../src/grading/grade.js";
import { loadArchivedTrials, writeGradeFile } from "../src/runner/archive.js";
import { classifyArchived } from "../src/runner/resume.js";
import { shortDigest } from "../src/shared/hashing.js";

const question = PublicQuestionSchema.parse({
  id: "phy-001",
  version: "1",
  subject: "physics",
  answerKind: "numeric_unit",
  stem: "Find the net force on a 2 kg block accelerating at 3 m/s^2.",
  assets: [],
});

const scoring = ScoringSpecSchema.parse({
  questionId: "phy-001",
  questionVersion: "1",
  scoringVersion: "1",
  answerKind: "numeric_unit",
  maxScore: 10,
  reference: "6",
  tolerance: 0.01,
  units: ["N"],
  deterministicLocked: true,
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

// configDigest exactly as trial-service derives it (run-level: question excluded).
function cfgDigest(spec: RunSpec): string {
  const { questionId: _qid, questionVersion: _qv, ...rest } = spec;
  return shortDigest(rest);
}

function fauxStream(answer: string): { streamFn: StreamFn; model: ReturnType<ReturnType<typeof fauxProvider>["getModel"]> } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(answer)]);
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

describe("R1-3/4/5 resume + archive (faux, no network)", () => {
  it("persists the Grade durably and reloads it with the Trial (report from archives)", async () => {
    const runsRoot = tmp("pi-runs-");
    const workRoot = tmp("pi-work-");
    const spec = runSpec();
    const { streamFn, model } = fauxStream("The answer is 6 N.");
    const { runId, trialId, trial } = await runOneTrial({ runSpec: spec, question, index: 0, streamFn, model, tools: [], toolsVersion: "v1", runsRoot, workRoot });
    expect(trial.executionStatus).toBe("completed");

    const g = gradeTrial(trial, question, scoring, "2026-10-09T00:00:00Z");
    expect(g.grade?.rawScore).toBe(10);
    writeGradeFile(runsRoot, runId, trialId, g.grade!);
    expect(existsSync(join(runsRoot, runId, "trials", trialId, "grade.json"))).toBe(true);

    const map = loadArchivedTrials(runsRoot, spec.mode, spec.provider, spec.modelId, cfgDigest(spec));
    const a = map.get("phy-001@1");
    expect(a?.trial.executionStatus).toBe("completed");
    expect(a?.grade?.rawScore).toBe(10); // grade reloaded from archive
    expect(classifyArchived(a!.trial, a!.hasAttempt)).toBe("load_completed");
  });

  it("records an attempt BEFORE dispatch; a dispatched-but-unrecorded answer is never auto-resent", async () => {
    const runsRoot = tmp("pi-runs-");
    const spec = runSpec();
    // A trial dir with an attempt.json (a request WAS dispatched) but no trial.json
    // (the archive write failed after the call) -> outcome unknown, NOT a resend.
    const trialId = "phy-001__without_tool__dispatched__0";
    const tdir = join(runsRoot, "runX", "trials", trialId);
    mkdirSync(tdir, { recursive: true });
    writeFileSync(
      join(tdir, "attempt.json"),
      JSON.stringify({
        trialId,
        runId: "runX",
        datasetId: "demo",
        datasetVersion: "1",
        questionId: "phy-001",
        questionVersion: "1",
        provider: "faux",
        modelId: "faux-1",
        mode: "without_tool",
        configDigest: cfgDigest(spec),
        promptVersion: "v1",
        toolsVersion: "v1",
        status: "dispatched",
        startedAt: "2026-10-09T00:00:00Z",
      }),
    );

    const map = loadArchivedTrials(runsRoot, spec.mode, spec.provider, spec.modelId, cfgDigest(spec));
    const a = map.get("phy-001@1");
    expect(a?.hasAttempt).toBe(true);
    expect(a?.trial.executionStatus).toBe("outcome_unknown"); // surfaced, not dropped
    expect(classifyArchived(a!.trial, a!.hasAttempt)).toBe("load_decision"); // NOT run -> no auto-resend
  });

  it("classifies archived statuses: only a clean failed_unprocessed with NO call may auto-retry", () => {
    const t = (executionStatus: Trial["executionStatus"]) => ({ executionStatus } as Trial);
    expect(classifyArchived(t("completed"), true)).toBe("load_completed");
    expect(classifyArchived(t("unsupported_input"), false)).toBe("load_completed"); // no call, terminal
    expect(classifyArchived(t("failed_unprocessed"), false)).toBe("run"); // call never made -> retryable
    expect(classifyArchived(t("failed_unprocessed"), true)).toBe("load_decision"); // call made -> no resend
    expect(classifyArchived(t("outcome_unknown"), false)).toBe("load_decision");
    expect(classifyArchived(t("interrupted"), false)).toBe("load_decision");
    expect(classifyArchived(t("limit_reached"), false)).toBe("load_decision");
  });

  it("a question VERSION change is a new answering identity (not skipped)", async () => {
    const runsRoot = tmp("pi-runs-");
    const workRoot = tmp("pi-work-");
    const spec = runSpec(); // questionVersion "1"
    const { streamFn, model } = fauxStream("The answer is 6 N.");
    await runOneTrial({ runSpec: spec, question, index: 0, streamFn, model, tools: [], toolsVersion: "v1", runsRoot, workRoot });

    const map = loadArchivedTrials(runsRoot, spec.mode, spec.provider, spec.modelId, cfgDigest(spec));
    expect(map.get("phy-001@1")).toBeTruthy();
    expect(map.get("phy-001@2")).toBeUndefined(); // version bump -> new identity -> re-answer
  });

  it("a model/CONFIG change is a new identity (no archive match -> re-answer)", async () => {
    const runsRoot = tmp("pi-runs-");
    const workRoot = tmp("pi-work-");
    const spec = runSpec();
    const { streamFn, model } = fauxStream("The answer is 6 N.");
    await runOneTrial({ runSpec: spec, question, index: 0, streamFn, model, tools: [], toolsVersion: "v1", runsRoot, workRoot });

    // Different toolsVersion -> different configDigest -> no match.
    const changed = runSpec({ toolsVersion: "v2" });
    const map = loadArchivedTrials(runsRoot, changed.mode, changed.provider, changed.modelId, cfgDigest(changed));
    expect(map.size).toBe(0);
  });
});
