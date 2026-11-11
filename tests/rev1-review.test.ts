import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { TaskControlService } from "../src/service/task-service.js";
import { ReviewService } from "../src/service/review-service.js";
import type { Registry } from "../src/providers/pi-adapter.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

function scriptedRegistry(): { registry: Registry; setResponses: (r: string[]) => void } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({
    id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "F1", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { text: "verified", imageInput: "verified", toolCalling: "verified", imageToolResult: "verified", usage: "verified", verificationEvidence: "t" },
  });
  return { registry: { models, profilesById: new Map([["faux", profile]]) }, setResponses: (r: string[]) => faux.setResponses(r.map((x) => fauxAssistantMessage(x))) };
}

describe("REV-1 human review wiring (confirm / model-prelim / persist / rebuild)", () => {
  it("queue -> model prelim (not counted) -> human confirm (counted) -> survives restart", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-rev-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    // an OPEN question (non-deterministic) so it lands in the review queue
    writeFileSync(join(publicDir, "o1.md"), `---\nid: o1\nversion: "1"\nsubject: physics\nanswer_kind: open\n---\n\nExplain why the sky is blue.\n`);
    writeFileSync(join(scoringDir, "o1.json"), JSON.stringify({ questionId: "o1", questionVersion: "1", scoringVersion: "1", answerKind: "open", maxScore: 10, deterministicLocked: false }));

    const s = scriptedRegistry();
    s.setResponses(["Rayleigh scattering scatters shorter wavelengths more."]);
    const tasks = new TaskControlService();
    const taskId = tasks.start({
      datasetId: "demo", datasetDir: root, modes: ["without_tool"], profileId: "faux", modelId: "faux-1", limit: 1,
      runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "x", registryOverride: s.registry,
    });
    const status = await tasks.whenDone(taskId);
    const runId = status!.runIds[0]!;

    const rev = new ReviewService(join(root, "runs"), root, "demo");
    const queue = await rev.getQueue(runId, "without_tool");
    expect(queue).toHaveLength(1);
    expect(queue[0]!.questionId).toBe("o1");
    expect(queue[0]!.answerSheet).toContain("Rayleigh");
    expect(queue[0]!.scoring?.maxScore).toBe(10);

    // model prelim (independent judge) -> model_preliminary, NOT counted
    const prelim = await rev.modelPrelim(runId, queue[0]!.trialId, async () => '{"score": 7, "evidence": "mostly right"}');
    expect(prelim.grade?.reviewStatus).toBe("model_preliminary");
    let report = await tasks.rebuildReport(join(root, "runs"), runId, root, "demo", "without_tool");
    expect(report.totals.confirmedRaw).toBe(0); // model prelim NOT counted

    // human confirm -> human_confirmed, counted
    const confirmed = await rev.submitHuman(runId, queue[0]!.trialId, { score: 8, reason: "good", confirmer: "grader-A" }, "without_tool");
    expect(confirmed.reviewStatus).toBe("human_confirmed");
    expect(confirmed.rawScore).toBe(8);
    expect(confirmed.maxScore).toBe(10); // from the scoring spec, NOT the human score (P1-6)
    expect(confirmed.scoringVersion).toBe("1"); // from the scoring spec, not hardcoded (P1-6)

    // survives restart: a fresh service reads the confirmed grade from disk
    const rev2 = new ReviewService(join(root, "runs"), root, "demo");
    const detail = new TaskControlService().getTaskDetail(join(root, "runs"), runId);
    expect(detail.questions[0]!.grade?.reviewStatus).toBe("human_confirmed");
    expect(detail.questions[0]!.grade?.rawScore).toBe(8);
    void rev2;
    report = await tasks.rebuildReport(join(root, "runs"), runId, root, "demo", "without_tool");
    expect(report.totals.confirmedRaw).toBe(8); // now counted
  });

  it("P1-6: an out-of-range human score is rejected (not silently clamped)", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-rev-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    writeFileSync(join(publicDir, "o1.md"), `---\nid: o1\nversion: "1"\nsubject: physics\nanswer_kind: open\n---\n\nExplain.\n`);
    writeFileSync(join(scoringDir, "o1.json"), JSON.stringify({ questionId: "o1", questionVersion: "1", scoringVersion: "1", answerKind: "open", maxScore: 10, deterministicLocked: false }));
    const s = scriptedRegistry();
    s.setResponses(["An answer."]);
    const tasks = new TaskControlService();
    const taskId = tasks.start({ datasetId: "demo", datasetDir: root, modes: ["without_tool"], profileId: "faux", modelId: "faux-1", limit: 1, runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "x", registryOverride: s.registry });
    const status = await tasks.whenDone(taskId);
    const runId = status!.runIds[0]!;
    const rev = new ReviewService(join(root, "runs"), root, "demo");
    const queue = await rev.getQueue(runId, "without_tool");
    await expect(rev.submitHuman(runId, queue[0]!.trialId, { score: 999, reason: "x", confirmer: "g" }, "without_tool")).rejects.toThrow(/out of range/);
  });

  it("P1-6: a human_confirmed grade whose scoring basis went stale re-enters the queue", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-rev-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    writeFileSync(join(publicDir, "o1.md"), `---\nid: o1\nversion: "1"\nsubject: physics\nanswer_kind: open\n---\n\nExplain.\n`);
    const scoringPath = join(scoringDir, "o1.json");
    writeFileSync(scoringPath, JSON.stringify({ questionId: "o1", questionVersion: "1", scoringVersion: "1", answerKind: "open", maxScore: 10, deterministicLocked: false }));
    const s = scriptedRegistry();
    s.setResponses(["An answer."]);
    const tasks = new TaskControlService();
    const taskId = tasks.start({ datasetId: "demo", datasetDir: root, modes: ["without_tool"], profileId: "faux", modelId: "faux-1", limit: 1, runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "x", registryOverride: s.registry });
    const status = await tasks.whenDone(taskId);
    const runId = status!.runIds[0]!;
    const rev = new ReviewService(join(root, "runs"), root, "demo");
    const q1 = await rev.getQueue(runId, "without_tool");
    await rev.submitHuman(runId, q1[0]!.trialId, { score: 8, reason: "good", confirmer: "g" }, "without_tool");
    expect(await rev.getQueue(runId, "without_tool")).toHaveLength(0); // confirmed & current -> not queued
    writeFileSync(scoringPath, JSON.stringify({ questionId: "o1", questionVersion: "1", scoringVersion: "2", answerKind: "open", maxScore: 12, deterministicLocked: false }));
    const q2 = await rev.getQueue(runId, "without_tool");
    expect(q2).toHaveLength(1); // stale human grade re-enters review
    expect(q2[0]!.reviewStatus).toBe("human_confirmed");
  });
});
