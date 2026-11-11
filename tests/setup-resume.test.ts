import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ModelProfileSchema, ProtectionLimitsSchema } from "../src/shared/contracts.js";
import { computeConfigDigest } from "../src/shared/ids.js";
import { runBatch } from "../src/runner/batch.js";
import { readManifest, writeManifest } from "../src/runner/answer-source.js";
import { TaskControlService } from "../src/service/task-service.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";

function fixture(reasoning = false, count = 2) {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "setup-resume-"));
  const datasetDir = join(root, "datasets", "demo");
  mkdirSync(join(datasetDir, "public"), { recursive: true });
  mkdirSync(join(datasetDir, "scoring"));
  const addQuestion = (id: string) => writeFileSync(join(datasetDir, "public", `${id}.md`), `---\nid: ${id}\nversion: "1"\nsubject: math\nanswer_kind: single_choice\n---\n\n2+2=? A.3 B.4\n`);
  for (let i = 1; i <= count; i++) addQuestion(`q${i}`);
  const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text"], reasoning, contextWindow: 4096, maxTokens: 1024 }] });
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning }] });
  faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("B")));
  const models = createModels();
  models.setProvider(faux.provider);
  const cfg = { datasetsRoot: join(root, "datasets"), modelsConfigPath: "unused", runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  const params = { ...cfg, datasetDir, datasetId: "demo", modes: ["without_tool"] as Array<"without_tool" | "with_tool">, profileId: "faux", modelId: "faux-1", limit: count };
  const service = new TaskControlService();
  const tui = new ExamTui(cfg, service);
  return { cfg, params, faux, service, tui, datasetDir, addQuestion };
}
afterEach(() => vi.restoreAllMocks());

describe("双模式、推理设置与指定历史续跑", () => {
  it("TUI 三档模式真正执行两套独立计划并可切换报告", async () => {
    const s = fixture();
    await s.tui.checkDataset("demo");
    s.tui.setSetup({ profileId: "faux", modelId: "faux-1", mode: "without_tool", concurrency: 2 });
    const app = new ExamApp(s.tui);
    app.handleInput("m");
    app.handleInput("m");
    const screen = s.tui.getState().screen;
    expect(screen.kind === "confirm" && screen.setup.mode).toBe("both");
    expect(stripTerminalSequences(app.render(80).join("\n"))).toContain("分别计分");
    const status = (await s.service.whenDone(s.tui.start()!))!;
    expect(status.state).toBe("done");
    expect(status.runIds).toHaveLength(2);
    expect(s.faux.state.callCount).toBe(4);
    const manifests = status.runIds.map((id) => readManifest(s.cfg.runsRoot, id)!);
    expect(manifests.map((m) => m.mode)).toEqual(["without_tool", "with_tool"]);
    expect(manifests[0]!.batchId).toBe(manifests[1]!.batchId);
    await s.tui.openReport(status.runIds[0]!, "with_tool");
    expect(s.tui.getState().screen).toMatchObject({ kind: "report", mode: "with_tool", runId: status.runIds[1] });
    app.dispose();
  });

  it("推理设置进入真实 Agent 请求且改变身份；显式 off 兼容旧默认", async () => {
    const s = fixture(true, 1);
    const observed: Array<string | undefined> = [];
    s.faux.setResponses([(_context, options) => { observed.push(options?.reasoning); return fauxAssistantMessage("B"); }]);
    const result = await runBatch({ ...s.params, thinkingLevel: "high" });
    const runId = result.byMode.without_tool!.runId;
    const manifest = readManifest(s.cfg.runsRoot, runId)!;
    expect(observed).toEqual(["high"]);
    expect(manifest.resumeConfig!.thinkingLevel).toBe("high");
    const detail = await s.service.getValidatedTaskDetail(s.cfg.runsRoot, runId, s.datasetDir, "demo", "without_tool");
    expect(detail.questions[0]!.metrics!.requests[0]!.requestedThinkingLevel).toBe("high");
    const identity = { datasetId: "demo", datasetVersion: "1", provider: "faux", modelId: "faux-1", mode: "without_tool" as const, promptVersion: "v1", toolsVersion: "v1", baseUrl: "https://faux.example/v1", api: "faux", model: { id: "faux-1", contextWindow: 4096, maxTokens: 1024, input: ["text"], reasoning: true }, limits: {} };
    expect(computeConfigDigest(identity)).toBe(computeConfigDigest({ ...identity, thinkingLevel: "off" }));
    expect(computeConfigDigest(identity)).not.toBe(computeConfigDigest({ ...identity, thinkingLevel: "high" }));
    await expect(runBatch({ ...s.params, runId, thinkingLevel: "low" })).rejects.toThrow("does not match");
    expect(s.faux.state.callCount).toBe(1);
  });

  it("非推理模型拒绝不支持等级且不发请求；确认页只轮换 SDK 支持等级", async () => {
    const s = fixture();
    await expect(runBatch({ ...s.params, thinkingLevel: "high" })).rejects.toThrow("does not support");
    expect(s.faux.state.callCount).toBe(0);
    s.tui.setSetup({ profileId: "faux", modelId: "faux-1", mode: "without_tool", concurrency: 1 });
    s.tui.cycleThinking();
    expect(s.tui.getState().screen).toMatchObject({ setup: { thinkingLevel: "off" } });
    await expect(runBatch({ ...s.params, modes: ["with_tool", "with_tool"] })).rejects.toThrow("unique");
    expect(s.faux.state.callCount).toBe(0);
  });

  it("指定续跑只执行原计划未开始题，保留完成及未知结果，不扩展后来新增题", async () => {
    const s = fixture(false, 3);
    s.faux.setResponses([fauxAssistantMessage("B"), fauxAssistantMessage([], { stopReason: "error", errorMessage: "offline interrupted stream" }), fauxAssistantMessage("B")]);
    const task = s.service.start(s.params);
    s.service.subscribe(task, (event) => { if (event.type === "question_done" && event.questionId === "q2") s.service.stop(task); });
    const initial = (await s.service.whenDone(task))!;
    const runId = initial.runIds[0]!;
    expect(s.faux.state.callCount).toBe(2);
    s.addQuestion("q4");
    await s.tui.prepareResume(runId);
    const confirm = s.tui.getState().screen;
    expect(confirm).toMatchObject({ kind: "confirm", resume: { queued: 1, retained: 1, blocked: 1 } });
    s.tui.adjustSetup({ mode: "both", thinkingLevel: "high", concurrency: 8 });
    expect(s.tui.getState().screen).toEqual(confirm);
    expect(s.faux.state.callCount).toBe(2);
    const resumed = (await s.service.whenDone(s.tui.start()!))!;
    expect(resumed.state).toBe("done");
    expect(s.faux.state.callCount).toBe(3);
    expect(readManifest(s.cfg.runsRoot, resumed.runIds[0]!)!.plannedQuestionIds).toEqual(["q1", "q2", "q3"]);
    await s.tui.prepareResume(resumed.runIds[0]!);
    const again = (await s.service.whenDone(s.tui.start()!))!;
    expect(again.state).toBe("done");
    expect(s.faux.state.callCount).toBe(3);
  });

  it("旧任务缺少快照时拒绝界面续跑；端点变化在发送前拒绝", async () => {
    const s = fixture(false, 1);
    const result = await runBatch(s.params);
    const runId = result.byMode.without_tool!.runId;
    const manifest = readManifest(s.cfg.runsRoot, runId)!;
    await expect(new ExamTui({ ...s.cfg, toolsVersion: "v2" }, s.service).prepareResume(runId)).rejects.toThrow("工具版本");
    s.cfg.registryOverride.profilesById.set("faux", { ...s.cfg.registryOverride.profilesById.get("faux")!, baseUrl: "https://changed.example/v1" });
    await s.tui.prepareResume(runId);
    expect((await s.service.whenDone(s.tui.start()!))!.state).toBe("error");
    expect(s.faux.state.callCount).toBe(1);
    const { resumeConfig: _snapshot, ...legacy } = manifest;
    writeManifest(s.cfg.runsRoot, runId, legacy);
    await expect(s.tui.prepareResume(runId)).rejects.toThrow("缺少可还原");
    expect(s.faux.state.callCount).toBe(1);
  });

  it("续跑恢复保存上限；80×24 确认页保持启动和返回可见", async () => {
    const s = fixture(false, 1);
    const limits = ProtectionLimitsSchema.parse({ maxOutputTokens: 777 });
    const result = await runBatch({ ...s.params, limitsOverride: limits });
    const runId = result.byMode.without_tool!.runId;
    await s.tui.prepareResume(runId);
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    const app = new ExamApp(s.tui);
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
      const lines = app.render(80);
      expect(lines).toHaveLength(24);
      expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
      const text = stripTerminalSequences(lines.join("\n"));
      expect(text).toContain("确认续跑（新请求可能计费）");
      expect(text).toContain("← 返回");
      app.handleInput("\x1b");
      await vi.waitFor(() => expect(s.tui.getState().screen).toMatchObject({ kind: "detail", runId }));
      await s.tui.prepareResume(runId);
    } finally {
      app.dispose();
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
    const status = (await s.service.whenDone(s.tui.start()!))!;
    expect(status.state).toBe("done");
    expect(readManifest(s.cfg.runsRoot, status.runIds[0]!)!.resumeConfig!.limits.maxOutputTokens).toBe(777);
    expect(s.faux.state.callCount).toBe(1);
  });
});
