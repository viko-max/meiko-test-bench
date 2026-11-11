import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { ExamTui } from "../src/tui/controller.js";
import { TaskControlService } from "../src/service/task-service.js";
import type { Registry } from "../src/providers/pi-adapter.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

function setup(): { datasetsRoot: string; modelsConfigPath: string; registry: Registry; faux: ReturnType<typeof fauxProvider> } {
  root = mkdtempSync(join(tmpdir(), "pi-tui-"));
  const datasetsRoot = join(root, "datasets");
  const dsDir = join(datasetsRoot, "demo");
  mkdirSync(join(dsDir, "public"), { recursive: true });
  mkdirSync(join(dsDir, "scoring"), { recursive: true });
  writeFileSync(join(dsDir, "public", "q1.md"), `---\nid: q1\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F.\n`);
  writeFileSync(join(dsDir, "scoring", "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));
  writeFileSync(join(dsDir, "public", "q2.md"), `---\nid: q2\nversion: "1"\nsubject: math\nanswer_kind: single_choice\n---\n\n2+2?\n\n- A. 3\n- B. 4\n`); // no scoring file -> unscored

  const profile = ModelProfileSchema.parse({
    id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "F1", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { text: "verified", imageInput: "verified", toolCalling: "verified", imageToolResult: "verified", usage: "verified", verificationEvidence: "t" },
  });
  const modelsConfigPath = join(root, "models.json");
  writeFileSync(modelsConfigPath, JSON.stringify({ version: "1", profiles: [profile] }));

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("F = 6 N"), fauxAssistantMessage("The answer is B.")]);
  const registry: Registry = { models, profilesById: new Map([["faux", profile]]) };
  return { datasetsRoot, modelsConfigPath, registry, faux };
}

describe("TUI-1 ExamTui controller drives the full flow via the service", () => {
  it("datasets -> check -> setup -> confirm -> run -> tasks -> detail -> report", async () => {
    const { datasetsRoot, modelsConfigPath, registry } = setup();
    const service = new TaskControlService();
    const tui = new ExamTui(
      { datasetsRoot, modelsConfigPath, runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", limitsPath: undefined, registryOverride: registry },
      service,
    );

    expect(tui.loadDatasets().map((d) => d.id)).toEqual(["demo"]);

    const report = await tui.checkDataset("demo");
    expect(report.total).toBe(2);
    expect(report.confirmed).toBe(2); // both import cleanly (q2 just unscored)
    expect(report.missingScoring).toEqual(["q2"]);
    expect(report.plannedMax).toBe(10);
    expect(report.byAnswerKind).toEqual({ numeric_unit: 1, single_choice: 1 });
    expect(tui.getState().screen.kind).toBe("check");

    tui.openSetup();
    expect(tui.getState().screen.kind).toBe("setup");
    tui.setSetup({ profileId: "faux", modelId: "faux-1", mode: "without_tool", concurrency: 1, apiConcurrency: 2 });
    expect(tui.getState().screen.kind).toBe("confirm");

    const taskId = tui.start();
    expect(taskId).toBeTruthy();
    expect(tui.getState().screen.kind).toBe("run");

    const status = await service.whenDone(taskId!);
    expect(status?.state).toBe("done");
    const runId = status!.runIds[0]!;

    await tui.openTasks();
    expect(tui.getState().screen.kind).toBe("tasks");
    await tui.openDetail(runId);
    const detail = tui.getState().screen;
    if (detail.kind !== "detail") throw new Error("expected detail");
    expect(detail.detail.questions.length).toBe(2);
    const q1 = detail.detail.questions.find((q) => q.questionId === "q1")!;
    expect(q1.executionStatus).toBe("completed");
    expect(q1.grade?.rawScore).toBe(10);

    await tui.openReport(runId, "without_tool");
    const rep = tui.getState().screen;
    if (rep.kind !== "report") throw new Error("expected report");
    expect(rep.report.totals.confirmedRaw).toBe(10); // q1 counted; q2 unscored shown-not-counted
    expect(rep.report.perQuestion.length).toBe(2);
  });

  it("stop moves to a stopped state and starts no further questions", async () => {
    const { datasetsRoot, modelsConfigPath, registry } = setup();
    const service = new TaskControlService();
    const tui = new ExamTui({ datasetsRoot, modelsConfigPath, runsRoot: join(root, "runs2"), workRoot: join(root, "work2"), toolsVersion: "v1", pythonInterpreter: "python", registryOverride: registry }, service);
    await tui.checkDataset("demo");
    tui.openSetup();
    tui.setSetup({ profileId: "faux", modelId: "faux-1", mode: "without_tool", concurrency: 1 });
    const taskId = tui.start()!;
    tui.stop();
    const status = await service.whenDone(taskId);
    expect(status?.state).toBe("stopped");
    expect(status!.events.filter((e) => e.type === "question_running")).toHaveLength(0);
  });

  it("stopAndWait requests stop AND waits for the task to finish (P1-2)", async () => {
    const { datasetsRoot, modelsConfigPath, registry } = setup();
    const service = new TaskControlService();
    const tui = new ExamTui({ datasetsRoot, modelsConfigPath, runsRoot: join(root, "runs3"), workRoot: join(root, "work3"), toolsVersion: "v1", pythonInterpreter: "python", registryOverride: registry }, service);
    await tui.checkDataset("demo");
    tui.openSetup();
    tui.setSetup({ profileId: "faux", modelId: "faux-1", mode: "without_tool", concurrency: 1 });
    const taskId = tui.start()!;
    await tui.stopAndWait();
    // after stopAndWait resolves the task is fully finished (no background work)
    const status = await service.whenDone(taskId);
    expect(status?.state).toBe("stopped");
    expect(tui.getState().message).toContain("已请求停止");
  });

  it("stopAndWait is a no-op when no task is running (P1-2)", async () => {
    const { datasetsRoot, modelsConfigPath, registry } = setup();
    const tui = new ExamTui({ datasetsRoot, modelsConfigPath, runsRoot: join(root, "runs4"), workRoot: join(root, "work4"), toolsVersion: "v1", pythonInterpreter: "python", registryOverride: registry });
    await expect(tui.stopAndWait()).resolves.toBeUndefined();
  });
});
