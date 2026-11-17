import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ModelProfileSchema, ProtectionLimitsSchema } from "../src/shared/contracts.js";
import { runBatch } from "../src/runner/batch.js";
import { readManifest } from "../src/runner/answer-source.js";
import { readBudget, BatchTokenBudget } from "../src/runner/batch-budget.js";
import { prepareRecovery } from "../src/runner/recovery.js";
import { TaskControlService } from "../src/service/task-service.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { EXAM_TOOLS_VERSION } from "../src/tools/index.js";
import * as json from "../src/shared/json.js";

const response = (tokens: number | null = 100, error = false) => {
  const message = fauxAssistantMessage(error ? "" : "B", error ? { stopReason: "error", errorMessage: "离线断流" } : {});
  message.usage = { ...message.usage, input: tokens === null ? 0 : tokens - 1, output: tokens === null ? 0 : 1, totalTokens: tokens ?? 0 };
  return message;
};
function fixture(count = 3) {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "budget-recovery-"));
  const datasetDir = join(root, "datasets", "demo");
  mkdirSync(join(datasetDir, "public"), { recursive: true }); mkdirSync(join(datasetDir, "scoring"));
  for (let i = 1; i <= count; i++) writeFileSync(join(datasetDir, "public", `q${i}.md`), `---\nid: q${i}\nversion: "1"\nsubject: math\nanswer_kind: single_choice\n---\n2+2=? A.3 B.4\n`);
  const model = { id: "faux-1", name: "Faux", input: ["text"] as "text"[], reasoning: false, contextWindow: 4096, maxTokens: 512 };
  const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.invalid", auth: { envVars: ["FAUX_KEY"] }, models: [model] });
  const faux = fauxProvider({ models: [model] }); const models = createModels(); models.setProvider(faux.provider);
  let usage: Array<number | null> = [];
  const originalStream = models.streamSimple.bind(models);
  // Faux 自动估算 usage；单独隔离供应商用量字段，构造明确用量及缺失边界。
  vi.spyOn(models, "streamSimple").mockImplementation((...args) => {
    const source = originalStream(...args); const total = usage.length ? usage.shift()! : 100;
    const apply = (message: ReturnType<typeof response>) => { message.usage = { ...message.usage,
      input: total === null ? 0 : total - 1, output: total === null ? 0 : 1, totalTokens: total ?? 0 }; return message; };
    return { [Symbol.asyncIterator]: async function* () {
      for await (const event of source) { if (event.type === "done") apply(event.message); else if (event.type === "error") apply(event.error); yield event; }
    }, result: async () => apply(await source.result()) } as AssistantMessageEventStream;
  });
  faux.setResponses(Array.from({ length: 20 }, () => response()));
  const cfg = { datasetsRoot: join(root, "datasets"), modelsConfigPath: "unused", runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: EXAM_TOOLS_VERSION, pythonInterpreter: "python", registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  const params = { ...cfg, datasetDir, datasetId: "demo", modes: ["without_tool"] as Array<"without_tool" | "with_tool">, profileId: "faux", modelId: "faux-1", limit: count, limitsOverride: ProtectionLimitsSchema.parse({ maxOutputTokens: 128 }) };
  const service = new TaskControlService(); const tui = new ExamTui(cfg, service);
  return { cfg, params, faux, service, tui, datasetDir, root, setUsage: (values: Array<number | null>) => { usage = values; } };
}
afterEach(() => vi.restoreAllMocks());

describe("批次预算与明确异常补答", () => {
  it("预算过小在第一个请求前拒绝，记录原因且不虚构消耗", async () => {
    const s = fixture(2);
    const result = await runBatch({ ...s.params, batchTokenLimit: 1 });
    expect(s.faux.state.callCount).toBe(0);
    const runId = result.byMode.without_tool!.runId;
    const ledger = readBudget(join(s.cfg.runsRoot, runId, "budget.json"));
    expect(ledger.knownTokens).toBe(0); expect(ledger.entries).toHaveLength(0);
    expect(s.service.getTaskDetail(s.cfg.runsRoot, runId).questions.every((q) => q.terminationCause === "batch_token_budget")).toBe(true);
  });

  it("两个模式共享额度并延续磁盘记录，续跑不清零也不重答完成题", async () => {
    const s = fixture(2);
    const params = { ...s.params, batchTokenLimit: 2000, modes: ["without_tool", "with_tool"] as const };
    const result = await runBatch({ ...params, modes: [...params.modes] });
    expect(s.faux.state.callCount).toBe(4);
    const first = result.byMode.without_tool!.runId, second = result.byMode.with_tool!.runId;
    expect(readManifest(s.cfg.runsRoot, second)?.budgetRunId).toBe(first);
    expect(readBudget(join(s.cfg.runsRoot, first, "budget.json")).knownTokens).toBe(400);
    const resumed = await runBatch({ ...s.params, batchTokenLimit: 2000, modes: ["with_tool"], runId: second });
    expect(s.faux.state.callCount).toBe(4);
    expect(readManifest(s.cfg.runsRoot, resumed.byMode.with_tool!.runId)?.budgetRunId).toBe(first);
    await expect(runBatch({ ...s.params, batchTokenLimit: 2001, modes: ["with_tool"], runId: second })).rejects.toThrow("原批次");
  });

  it("并发请求先预留，额度不足不超发；完成后保留真实用量", async () => {
    const s = fixture(2);
    s.setUsage([300]);
    s.faux.setResponses([async () => { await new Promise((r) => setTimeout(r, 80)); return response(300); }]);
    const result = await runBatch({ ...s.params, batchTokenLimit: 850, concurrency: 2 });
    expect(s.faux.state.callCount).toBe(1);
    const runId = result.byMode.without_tool!.runId;
    expect(readBudget(join(s.cfg.runsRoot, runId, "budget.json"))).toMatchObject({ knownTokens: 300, reservedTokens: 0 });
    expect(s.service.getTaskDetail(s.cfg.runsRoot, runId).questions.map((q) => q.executionStatus).sort()).toEqual(["completed", "limit_reached"]);
  });

  it("用量缺失停止新题；人工核对需要依据，保存后能继续未开始题", async () => {
    const s = fixture(); s.setUsage([null, 100, 100]); s.faux.setResponses([response(null), response(), response()]);
    const first = await runBatch({ ...s.params, batchTokenLimit: 5000 });
    const runId = first.byMode.without_tool!.runId;
    expect(s.faux.state.callCount).toBe(1);
    const path = join(s.cfg.runsRoot, runId, "budget.json");
    const before = readBudget(path); expect(before).toMatchObject({ knownTokens: 0, unknownRequests: 1, blocked: true });
    const resumed = await runBatch({ ...s.params, batchTokenLimit: 5000, runId });
    expect(s.faux.state.callCount).toBe(1);
    await expect(s.service.reconcileUsage(s.cfg.runsRoot, runId, before.entries[0]!.id, 80, "", "供应商记录")).rejects.toThrow();
    await s.service.reconcileUsage(s.cfg.runsRoot, runId, before.entries[0]!.id, 80, "meiko", "供应商请求记录确认80");
    expect(readBudget(path).entries[0]).toMatchObject({ actual: 80, state: "known", reconciliation: { by: "meiko" } });
    await runBatch({ ...s.params, batchTokenLimit: 5000, runId: resumed.byMode.without_tool!.runId });
    expect(s.faux.state.callCount).toBe(3);
    expect(readBudget(path).knownTokens).toBe(280);
  });

  it("用量未知后，已排队等待 API 名额的请求同样不能发送", async () => {
    const s = fixture(2); s.setUsage([null]);
    s.faux.setResponses([async () => { await new Promise((r) => setTimeout(r, 30)); return response(); }, response()]);
    await runBatch({ ...s.params, batchTokenLimit: 5000, concurrency: 2, requestSchedulerLimits: { maxConcurrent: 1, minIntervalMs: 0 } });
    expect(s.faux.state.callCount).toBe(1);
  });

  it("进程遗留预留恢复为未知，损坏/缺失预算拒绝重置", () => {
    const s = fixture(1), path = join(s.root, "ledger.json");
    writeFileSync(path, JSON.stringify({ version: 1, maxTotalTokens: 1000, entries: [{ id: "req", runId: "run", trialId: "trial", questionId: "q1", reserved: 500, actual: null, state: "active" }] }));
    expect(new BatchTokenBudget(path, 1000, true).snapshot()).toMatchObject({ unknownRequests: 1, unknownReservedTokens: 500, blocked: true });
    expect(() => new BatchTokenBudget(join(s.root, "missing.json"), 1000, true)).toThrow("缺失");
    writeFileSync(path, "{}"); expect(() => new BatchTokenBudget(path, 1000, true)).toThrow();
  });

  it("每轮工具后的请求也经过预算，不在额度不足时继续发送", async () => {
    const s = fixture(1); s.setUsage([1800]);
    s.faux.setResponses([fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" })), response()]);
    const result = await runBatch({ ...s.params, modes: ["with_tool"], batchTokenLimit: 2400 });
    expect(s.faux.state.callCount).toBe(1);
    const detail = s.service.getTaskDetail(s.cfg.runsRoot, result.byMode.with_tool!.runId);
    expect(detail.questions[0]).toMatchObject({ executionStatus: "limit_reached", terminationCause: "batch_token_budget" });
    expect(detail.questions[0]!.metrics?.toolCalls).toBe(1);
  }, 15000);

  it("预算落盘失败停止后续请求，保留磁盘上的计费预留", async () => {
    const s = fixture(2);
    const save = json.writeJsonAtomic;
    vi.spyOn(json, "writeJsonAtomic").mockImplementation((path, value) => {
      if (path.endsWith("budget.json") && (value as { entries?: Array<{ state: string }> }).entries?.some((e) => e.state === "known")) throw new Error("离线模拟磁盘写入失败");
      save(path, value);
    });
    const id = s.service.start({ ...s.params, batchTokenLimit: 5000 }); const status = await s.service.whenDone(id);
    expect(s.faux.state.callCount).toBe(1); expect(status?.state).toBe("budget_paused");
    const path = join(s.cfg.runsRoot, status!.runIds[0]!, "budget.json");
    expect(readBudget(path).entries[0]!.state).toBe("active");
  });

  it("已完成但用量未知的题仍可核对；TUI 核对两次确认后保存，无模型调用", async () => {
    const s = fixture(2); s.setUsage([null]);
    const id = s.service.start({ ...s.params, batchTokenLimit: 5000 }); const status = await s.service.whenDone(id);
    expect(status?.state).toBe("budget_paused");
    const runId = status!.runIds[0]!; await s.tui.openExceptions(runId);
    expect(s.tui.getState().screen).toMatchObject({ kind: "exceptions", data: { items: [{ questionId: "q1", question: { executionStatus: "completed" } }, { questionId: "q2" }] } });
    s.tui.openUsageReconciliation(); expect(s.tui.getState().screen.kind).toBe("usage");
    s.tui.setExceptionField("total", "80"); s.tui.setExceptionField("by", "meiko"); s.tui.setExceptionField("reason", "供应商用量记录");
    await s.tui.confirmUsage(); expect(s.tui.getState().screen).toMatchObject({ kind: "usage", confirming: true });
    expect(readBudget(join(s.cfg.runsRoot, runId, "budget.json")).unknownRequests).toBe(1);
    await s.tui.confirmUsage(); expect(s.tui.getState().screen).toMatchObject({ kind: "exceptions", data: { budget: { reconciledTokens: 80, unknownRequests: 0 } } });
    expect(s.faux.state.callCount).toBe(1);
  });

  it("异常补答仅运行指定一题，旧记录不改；同一决定重复使用被拒绝", async () => {
    const s = fixture(); s.faux.setResponses([response(100, true), response(), response()]);
    const result = await runBatch(s.params); const runId = result.byMode.without_tool!.runId;
    const decision = await prepareRecovery(s.cfg.runsRoot, runId, s.datasetDir, "demo", "q1");
    const original = join(s.cfg.runsRoot, decision.location.runId, "trials", decision.trialId, "trial.json");
    const old = readFileSync(original, "utf8");
    s.faux.appendResponses([response()]);
    const params = { ...s.params, runId, recoveryDecision: { questionId: "q1", trialId: decision.trialId, token: decision.token, by: "meiko", reason: "确认无有效答卷后补答" } };
    const recovered = await runBatch(params);
    expect(s.faux.state.callCount).toBe(4); expect(readFileSync(original, "utf8")).toBe(old);
    const newId = recovered.byMode.without_tool!.runId;
    expect(readManifest(s.cfg.runsRoot, newId)?.recovery).toMatchObject({ sourceRunId: runId, questionId: "q1", by: "meiko" });
    expect(recovered.byMode.without_tool!.report.perQuestion.every((q) => q.executionStatus === "completed")).toBe(true);
    await expect(runBatch(params)).rejects.toThrow("已发起过补答"); expect(s.faux.state.callCount).toBe(4);
    await expect(prepareRecovery(s.cfg.runsRoot, runId, s.datasetDir, "demo", "q2")).rejects.toThrow("只允许");
    expect(existsSync(decision.marker)).toBe(true);
  });

  it("材料或决定内容变化时拒绝补答，不产生新请求", async () => {
    const s = fixture(1); s.faux.setResponses([response(100, true)]);
    const result = await runBatch(s.params); const runId = result.byMode.without_tool!.runId;
    const decision = await prepareRecovery(s.cfg.runsRoot, runId, s.datasetDir, "demo", "q1");
    const d = { questionId: "q1", trialId: decision.trialId, token: "stale", by: "meiko", reason: "有依据" };
    await expect(runBatch({ ...s.params, runId, recoveryDecision: d })).rejects.toThrow("已变化");
    writeFileSync(join(s.datasetDir, "public", "q1.md"), "changed");
    await expect(runBatch({ ...s.params, runId, recoveryDecision: { ...d, token: decision.token } })).rejects.toThrow();
    expect(s.faux.state.callCount).toBe(1);
  });

  it("TUI 异常入口、字段校验、两次确认和小窗口按钮可见", async () => {
    const s = fixture(1); s.faux.setResponses([response(100, true)]);
    const result = await runBatch(s.params); const runId = result.byMode.without_tool!.runId;
    await s.tui.openDetail(runId); const app = new ExamApp(s.tui);
    try {
      app.handleInput("x"); await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("exceptions"));
      await expect(s.tui.prepareExceptionRecovery()).rejects.toThrow("填写决定人");
      s.tui.setExceptionField("by", "meiko"); s.tui.setExceptionField("reason", "确认异常补答");
      await s.tui.prepareExceptionRecovery();
      const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
      try {
        Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
        const lines = app.render(80); const text = stripTerminalSequences(lines.join("\n"));
        expect(lines).toHaveLength(24); expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
        expect(text).toContain("明确补答一次（可能再次计费）"); expect(text).toContain("← 返回");
      } finally { if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows"); }
      expect(s.faux.state.callCount).toBe(1);
      app.handleInput("\x1b"); await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("detail"));
      await s.tui.checkDataset("demo"); s.tui.setSetup({ profileId: "faux", modelId: "faux-1", mode: "without_tool", concurrency: 1 });
      expect(() => s.tui.setBatchTokenLimit("-1")).toThrow(); s.tui.setBatchTokenLimit("5000");
      expect(s.tui.getState().screen).toMatchObject({ setup: { batchTokenLimit: 5000 } });
    } finally { app.dispose(); }
  });
});
