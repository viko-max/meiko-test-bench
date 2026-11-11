import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { ModelProfileSchema, type AnswerMode } from "../src/shared/contracts.js";
import { runBatch, type BatchParams } from "../src/runner/batch.js";
import { TaskControlService } from "../src/service/task-service.js";
import type { Registry } from "../src/providers/pi-adapter.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

function scriptedRegistry(): { registry: Registry; setResponses: (r: string[]) => void; callCount: () => number } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({
    id: "faux",
    displayName: "Faux",
    provider: "faux",
    api: "faux",
    baseUrl: "http://localhost/",
    auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "Faux 1", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { text: "verified", imageInput: "verified", toolCalling: "verified", imageToolResult: "verified", usage: "verified", verificationEvidence: "test" },
  });
  return {
    registry: { models, profilesById: new Map([["faux", profile]]) },
    setResponses: (r: string[]) => faux.setResponses(r.map((x) => fauxAssistantMessage(x))),
    callCount: () => faux.state.callCount,
  };
}

describe("R1-4 batch resume: report = old + new from archives (faux, no network)", () => {
  it("partial run then resume: completed never re-requested, totals unchanged", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-batch-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    writeFileSync(join(publicDir, "q1.md"), `---\nid: q1\nversion: "1"\nsubject: mathematics\nanswer_kind: single_choice\n---\n\n2+2=?\n\n- A. 3\n- B. 4\n- C. 5\n`);
    writeFileSync(join(scoringDir, "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true }));
    writeFileSync(join(publicDir, "q2.md"), `---\nid: q2\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F for m=2,a=3.\n`);
    writeFileSync(join(scoringDir, "q2.json"), JSON.stringify({ questionId: "q2", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));

    const s = scriptedRegistry();
    // One queue: run#1 consumes [0] (q1), run#2 consumes [1] (q2); run#3 none.
    s.setResponses(["The answer is B.", "F = 6 N"]);

    const base: Omit<BatchParams, "limit" | "resume" | "onProgress"> = {
      datasetId: "demo",
      datasetDir: root,
      modes: ["without_tool" as AnswerMode],
      profileId: "faux",
      modelId: "faux-1",
      runsRoot: join(root, "runs"),
      workRoot: join(root, "work"),
      toolsVersion: "v1",
      pythonInterpreter: "python",
      modelsConfigPath: "(unused: registryOverride)",
      registryOverride: s.registry,
    };

    // --- Run #1: only q1 ---
    const r1 = await runBatch({ ...base, limit: 1, resume: false, onProgress: () => {} });
    expect(r1.byMode["without_tool"]!.report.totals.confirmedRaw).toBe(5);
    expect(r1.byMode["without_tool"]!.report.totals.plannedMax).toBe(5); // limit=1 -> only q1 planned
    expect(s.callCount()).toBe(1); // only q1 answered

    // --- Run #2: resume, limit=2 -> q1 loaded from archive, q2 answered ---
    const r2 = await runBatch({ ...base, limit: 2, resume: true, onProgress: () => {} });
    expect(s.callCount()).toBe(2); // ONLY q2 was requested; q1 was NOT re-sent
    const rep2 = r2.byMode["without_tool"]!.report;
    expect(rep2.totals.confirmedRaw).toBe(15); // old (q1=5) + new (q2=10)
    expect(rep2.totals.confirmedMax).toBe(15);
    expect(rep2.perQuestion.map((r) => r.questionId).sort()).toEqual(["q1", "q2"]);

    // --- Run #3: resume again, all done -> NO new requests, score unchanged ---
    const r3 = await runBatch({ ...base, limit: 2, resume: true, onProgress: () => {} });
    expect(s.callCount()).toBe(2); // zero additional requests
    expect(r3.byMode["without_tool"]!.report.totals.confirmedRaw).toBe(15); // unchanged
    expect(r3.byMode["without_tool"]!.report.totals.confirmedMax).toBe(15);
  });

  it("P1-1: a repeat start WITHOUT --fresh dedups (no re-bill); --fresh re-answers", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-batch-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    writeFileSync(join(publicDir, "q1.md"), `---\nid: q1\nversion: "1"\nsubject: mathematics\nanswer_kind: single_choice\n---\n\n2+2=?\n\n- A. 3\n- B. 4\n- C. 5\n`);
    writeFileSync(join(scoringDir, "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true }));
    writeFileSync(join(publicDir, "q2.md"), `---\nid: q2\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F for m=2,a=3.\n`);
    writeFileSync(join(scoringDir, "q2.json"), JSON.stringify({ questionId: "q2", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));

    const s = scriptedRegistry();
    s.setResponses(["The answer is B.", "F = 6 N", "The answer is B.", "F = 6 N"]);
    const base: Omit<BatchParams, "limit" | "resume" | "onProgress"> = {
      datasetId: "demo", datasetDir: root, modes: ["without_tool" as AnswerMode], profileId: "faux", modelId: "faux-1",
      runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python",
      modelsConfigPath: "(unused: registryOverride)", registryOverride: s.registry,
    };

    // Run #1: no resume/fresh — dedup is the default, but the archive is empty -> answers both.
    const r1 = await runBatch({ ...base, limit: 2, onProgress: () => {} });
    expect(s.callCount()).toBe(2);

    // Run #2: repeat start, STILL no --fresh -> must dedup against the archive, NOT re-bill.
    const r2 = await runBatch({ ...base, limit: 2, onProgress: () => {} });
    expect(s.callCount()).toBe(2); // unchanged: completed questions were NOT re-sent
    expect(r2.byMode["without_tool"]!.report.totals.confirmedRaw).toBe(15);
    expect(r2.byMode["without_tool"]!.report.totals.confirmedMax).toBe(15);

    // Run #3: explicit --fresh -> ignore the archive and re-answer (re-bill).
    const r3 = await runBatch({ ...base, limit: 2, fresh: true, onProgress: () => {} });
    expect(s.callCount()).toBe(4); // both re-answered
  });

  it("P1-4: rebuildReport reloads resumed-from-archive answers via the manifest", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-batch-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    writeFileSync(join(publicDir, "q1.md"), `---\nid: q1\nversion: "1"\nsubject: mathematics\nanswer_kind: single_choice\n---\n\n2+2=?\n\n- A. 3\n- B. 4\n- C. 5\n`);
    writeFileSync(join(scoringDir, "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true }));
    writeFileSync(join(publicDir, "q2.md"), `---\nid: q2\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F for m=2,a=3.\n`);
    writeFileSync(join(scoringDir, "q2.json"), JSON.stringify({ questionId: "q2", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));

    const s = scriptedRegistry();
    s.setResponses(["The answer is B.", "F = 6 N"]);
    const base: Omit<BatchParams, "limit" | "resume" | "onProgress"> = {
      datasetId: "demo", datasetDir: root, modes: ["without_tool" as AnswerMode], profileId: "faux", modelId: "faux-1",
      runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python",
      modelsConfigPath: "(unused: registryOverride)", registryOverride: s.registry,
    };
    await runBatch({ ...base, limit: 1, onProgress: () => {} }); // q1 only
    const r2 = await runBatch({ ...base, limit: 2, resume: true, onProgress: () => {} }); // q1 resumed + q2 answered
    const run2Id = r2.byMode["without_tool"]!.runId;

    // Rebuild from run #2's dir alone: must include q1 (resumed from run #1 via the
    // manifest) AND q2 — a plain scan of run #2's dir would MISS q1.
    const report = await new TaskControlService().rebuildReport(join(root, "runs"), run2Id, root, "demo", "without_tool");
    expect(report.perQuestion.map((r) => r.questionId).sort()).toEqual(["q1", "q2"]);
    expect(report.totals.confirmedRaw).toBe(15); // q1(5) + q2(10)
  });

  it("P1-1: rebuild re-validates the content digest — a changed question is BLOCKED, not re-counted", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-batch-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    const q1path = join(publicDir, "q1.md");
    writeFileSync(q1path, `---\nid: q1\nversion: "1"\nsubject: mathematics\nanswer_kind: single_choice\n---\n\n2+2=?\n\n- A. 3\n- B. 4\n- C. 5\n`);
    writeFileSync(join(scoringDir, "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true }));
    const s = scriptedRegistry();
    s.setResponses(["The answer is B."]);
    const base: Omit<BatchParams, "limit" | "resume" | "onProgress"> = {
      datasetId: "demo", datasetDir: root, modes: ["without_tool" as AnswerMode], profileId: "faux", modelId: "faux-1",
      runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python",
      modelsConfigPath: "(unused: registryOverride)", registryOverride: s.registry,
    };
    const r1 = await runBatch({ ...base, limit: 1, onProgress: () => {} });
    const runId = r1.byMode["without_tool"]!.runId;
    let report = await new TaskControlService().rebuildReport(join(root, "runs"), runId, root, "demo", "without_tool");
    expect(report.totals.confirmedRaw).toBe(5); // baseline: q1 counted

    // The QUESTION CONTENT changes (same id+version, different stem) — the archived
    // answer no longer applies.
    writeFileSync(q1path, `---\nid: q1\nversion: "1"\nsubject: mathematics\nanswer_kind: single_choice\n---\n\nWhat is 3+3?\n\n- A. 5\n- B. 6\n- C. 7\n`);
    report = await new TaskControlService().rebuildReport(join(root, "runs"), runId, root, "demo", "without_tool");
    expect(report.totals.confirmedRaw).toBe(0); // NOT re-counted under the changed content
    const row = report.perQuestion.find((r) => r.questionId === "q1");
    expect(row).toBeDefined(); // does not silently vanish
    expect(row!.executionStatus).toBe("outcome_unknown"); // blocked, shown-not-counted
  });
});
