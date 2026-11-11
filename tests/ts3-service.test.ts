import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { ModelProfileSchema, type AnswerMode } from "../src/shared/contracts.js";
import { TaskControlService } from "../src/service/task-service.js";
import type { Registry } from "../src/providers/pi-adapter.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

function scriptedRegistry(): { registry: Registry; setResponses: (r: string[]) => void } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({
    id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "Faux 1", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { text: "verified", imageInput: "verified", toolCalling: "verified", imageToolResult: "verified", usage: "verified", verificationEvidence: "t" },
  });
  return { registry: { models, profilesById: new Map([["faux", profile]]) }, setResponses: (r: string[]) => faux.setResponses(r.map((x) => fauxAssistantMessage(x))) };
}

function makeDataset(n: number): { datasetDir: string; runsRoot: string; workRoot: string } {
  const datasetDir = mkdtempSync(join(tmpdir(), "pi-ts3-ds-"));
  const publicDir = join(datasetDir, "public");
  const scoringDir = join(datasetDir, "scoring");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(scoringDir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const qid = `q${i}`;
    writeFileSync(join(publicDir, `${qid}.md`), `---\nid: ${qid}\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F.\n`);
    writeFileSync(join(scoringDir, `${qid}.json`), JSON.stringify({ questionId: qid, questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));
  }
  return { datasetDir, runsRoot: join(datasetDir, "runs"), workRoot: join(datasetDir, "work") };
}

const baseParams = (ds: { datasetDir: string; runsRoot: string; workRoot: string }, registry: Registry, limit: number) => ({
  datasetId: "demo", datasetDir: ds.datasetDir, modes: ["without_tool" as AnswerMode], profileId: "faux", modelId: "faux-1",
  limit, runsRoot: ds.runsRoot, workRoot: ds.workRoot, toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "x", registryOverride: registry,
});

describe("TS-3 TaskControlService (start / stop / read / rebuild)", () => {
  it("start -> done -> listTasks -> getTaskDetail -> rebuildReport", async () => {
    const ds = makeDataset(2);
    const s = scriptedRegistry();
    s.setResponses(["F = 6 N", "F = 6 N"]);
    const svc = new TaskControlService();
    const taskId = svc.start(baseParams(ds, s.registry, 2));
    const status = await svc.whenDone(taskId);
    expect(status?.state).toBe("done");
    expect(status?.runIds).toHaveLength(1);
    const runId = status!.runIds[0]!;

    expect(svc.listTasks(ds.runsRoot).some((t) => t.runId === runId && t.hasReport)).toBe(true);

    const detail = svc.getTaskDetail(ds.runsRoot, runId);
    expect(detail.questions).toHaveLength(2);
    expect(detail.questions.every((q) => q.executionStatus === "completed")).toBe(true);
    expect(detail.questions.every((q) => q.grade?.rawScore === 10)).toBe(true);
    expect(detail.report?.totals.confirmedRaw).toBe(20);

    const rebuilt = await svc.rebuildReport(ds.runsRoot, runId, ds.datasetDir, "demo", "without_tool");
    expect(rebuilt.totals.confirmedRaw).toBe(20); // consistent with the live report
    expect(rebuilt.perQuestion).toHaveLength(2);
    rmSync(ds.datasetDir, { recursive: true, force: true });
  });

  it("stop halts before starting new questions", async () => {
    const ds = makeDataset(4);
    const s = scriptedRegistry();
    s.setResponses(["F = 6 N", "F = 6 N", "F = 6 N", "F = 6 N"]);
    const svc = new TaskControlService();
    const taskId = svc.start(baseParams(ds, s.registry, 4));
    svc.stop(taskId); // stop immediately
    const status = await svc.whenDone(taskId);
    expect(status?.state).toBe("stopped");
    const running = status!.events.filter((e) => e.type === "question_running");
    expect(running).toHaveLength(0); // nothing started after stop
    rmSync(ds.datasetDir, { recursive: true, force: true });
  });
});
