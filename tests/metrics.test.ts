import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type Models, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { RequestMetricsCollector, applyNativeUsage } from "../src/runner/request-metrics.js";
import { emptyUsage, RequestMetricsSchema, summarizeRequests, type RequestMetrics } from "../src/shared/metrics.js";
import { taskTelemetry } from "../src/service/task-metrics.js";
import { TaskControlService } from "../src/service/task-service.js";
import { ModelProfileSchema, PublicQuestionSchema, RunSpecSchema } from "../src/shared/contracts.js";
import { runOneTrial } from "../src/runner/trial-service.js";
import { InMemoryTrialRecorder } from "../src/storage/recorder.js";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { readManifest } from "../src/runner/answer-source.js";
import type { TaskEvent } from "../src/runner/task-events.js";
import { ExamApp } from "../src/tui/app.js";
import { ExamTui } from "../src/tui/controller.js";
import { prepareMascotImage } from "../src/tui/mascot.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { metricTotal } from "../src/tui/metrics-view.js";

const model = fauxProvider().getModel();
const request = (overrides: Partial<RequestMetrics> = {}): RequestMetrics => RequestMetricsSchema.parse({
  id: "request-1", api: "openai-completions", startedAt: "2026-10-15T00:00:00Z", lastActivityAt: "2026-10-15T00:00:01Z",
  endedAt: "2026-10-15T00:00:01Z", elapsedMs: 1000, firstOutputMs: null, firstTextMs: null,
  status: "completed", phase: "answering", requestedThinkingLevel: "off", sentThinking: null, reportedThinkingLevel: null,
  usage: emptyUsage(), usageSource: "unavailable", evidence: {}, ...overrides,
});
async function drain(stream: AssistantMessageEventStream) {
  for await (const _event of stream) { /* 消费 Pi 真实事件接口。 */ }
  return stream.result();
}
afterEach(() => vi.restoreAllMocks());

function singleTrialFixture() {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "metrics-verification-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const question = PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "math", answerKind: "single_choice", stem: "2+2=? A.3 B.4", assets: [] });
  const recorder = new InMemoryTrialRecorder();
  const params = { runSpec: RunSpecSchema.parse({ datasetId: "demo", datasetVersion: "1", questionId: "q1", questionVersion: "1", provider: "faux", modelId: model.id, mode: "with_tool", promptVersion: "v1", toolsVersion: "v1", limits: {} }),
    question, index: 0, streamFn: makeExamStreamFn(models), model: faux.getModel(), tools: [], toolsVersion: "v1", runsRoot: join(root, "runs"), workRoot: join(root, "work"), recorder };
  return { faux, recorder, params };
}

describe("指标的来源、缺失值与计算口径", () => {
  it("原始缺失与真实零分别保存，推理不再计入总数两次", () => {
    const r = request();
    applyNativeUsage(r, { usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 10 }, prompt_tokens_details: { cached_tokens: 0 } } });
    expect(r.usage).toMatchObject({ input: 100, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: null, totalTokens: 120 });
    const summary = summarizeRequests([r], 2000);
    expect(summary.cacheHitRate).toBe(0);
    expect(summary.requestTps).toBe(20);
    expect(summary.batchTps).toBe(10);
    expect(summary.tokens.cacheWrite.value).toBeNull();
    expect(r.evidence).not.toHaveProperty("cache_write_tokens");
  });

  it("Anthropic 分段累计值覆盖旧快照，保留缓存计入总输入的口径", () => {
    const r = request({ api: "anthropic-messages" });
    applyNativeUsage(r, { type: "message_start", message: { usage: { input_tokens: 80, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } });
    expect(r.usage.reasoning).toBeNull();
    applyNativeUsage(r, { type: "message_delta", usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } } });
    expect(r.usage).toMatchObject({ input: 100, uncachedInput: 80, output: 20, totalTokens: 120, reasoning: 5 });
    expect(summarizeRequests([r]).cacheHitRate).toBe(0.2);
  });

  it("部分请求缺失时显示已知小计及覆盖，不输出伪完整 TPS 或缓存命中率", () => {
    const first = request();
    applyNativeUsage(first, { usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 50 } });
    const summary = summarizeRequests([first, request({ id: "request-2", status: "failed" })]);
    expect(summary.incompleteRequests).toBe(1);
    expect(summary.tokens.output).toEqual({ value: 20, known: 1, total: 2 });
    expect(metricTotal(summary.tokens.output)).toBe("20（已知 1/2）");
    expect(summary.requestTps).toBeNull();
    expect(summary.cacheHitRate).toBeNull();
    expect(summarizeRequests([]).tokens.input.value).toBeNull();
  });

  it("忽略无效计数与错误分母，不产生 NaN、Infinity 或超过 100% 的命中率", () => {
    const r = request();
    applyNativeUsage(r, { usage: { prompt_tokens: 0, completion_tokens: -1, cached_tokens: 30, total_tokens: Infinity } });
    expect(r.usage.output).toBeNull();
    expect(r.usage.totalTokens).toBeNull();
    expect(summarizeRequests([r]).cacheHitRate).toBeNull();
  });

  it("同一请求的实时快照只替换一次；两模式独立，旧答卷不记为本次消耗", () => {
    const start: TaskEvent = { type: "task_started", runId: "r", mode: "without_tool", datasetId: "demo", provider: "local", modelId: "m", plannedQuestionIds: ["q", "old"], at: "2026-10-15T00:00:00Z" };
    const first = request();
    applyNativeUsage(first, { usage: { prompt_tokens: 100, completion_tokens: 20 } });
    const events: TaskEvent[] = [start, { type: "request_metrics", runId: "r", mode: "without_tool", questionId: "q", request: first },
      { type: "request_metrics", runId: "r", mode: "without_tool", questionId: "q", request: { ...first, elapsedMs: 2000 } },
      { type: "question_loaded", runId: "r", mode: "without_tool", questionId: "old", executionStatus: "outcome_unknown", note: "needs decision" }];
    const view = taskTelemetry(events, Date.parse("2026-10-15T00:00:03Z"))!;
    expect(view.summary.tokens.output.value).toBe(20);
    expect(view.summary.requests).toBe(1);
    expect(view.questions[1]).toMatchObject({ reused: true, state: "outcome_unknown", requests: [] });
    events.push({ ...start, runId: "other", mode: "with_tool" });
    expect(taskTelemetry(events)!.summary.requests).toBe(0);
  });
});

describe("真实 Pi 流的旁路采集", () => {
  it("工具失败后模型继续作答，两次请求和一次失败工具均被记录", async () => {
    const s = singleTrialFixture();
    s.faux.setResponses([fauxAssistantMessage(fauxToolCall("offline_tool", {})), fauxAssistantMessage("B")]);
    const activity = vi.fn();
    const result = await runOneTrial({ ...s.params, onToolActivity: activity,
      tools: [{ name: "offline_tool", label: "Offline boundary", description: "Deterministic tool failure fixture", parameters: Type.Object({}), execute: async () => { throw new Error("offline tool failure"); } }] });
    expect(result.trial.executionStatus).toBe("completed");
    expect(result.trial.metrics).toMatchObject({ toolCalls: 1, toolErrors: 1 });
    expect(result.trial.metrics!.requests).toHaveLength(2);
    expect(activity.mock.calls.map(([event]) => event.running)).toEqual([true, false]);
    expect(activity.mock.calls[1]![0].isError).toBe(true);
    expect(s.faux.state.callCount).toBe(2);
  });

  it("指标日志写入失败不丢失已获得的答卷，错误可见且不重发", async () => {
    const s = singleTrialFixture();
    s.faux.setResponses([fauxAssistantMessage("B")]);
    const record = s.recorder.recordEvent.bind(s.recorder);
    s.recorder.recordEvent = (event) => {
      if (["request_metrics", "trial_metrics"].includes((event as { type: string }).type)) throw new Error("offline disk error");
      record(event);
    };
    const result = await runOneTrial(s.params);
    expect(result.trial.executionStatus).toBe("completed");
    expect(result.trial.finalAnswerSheet).toBe("B");
    expect(result.archiveError).toContain("metrics log persist failed");
    expect(s.faux.state.callCount).toBe(1);
  });

  it("挂起流仍由原看门狗取消，指标记录结束且没有重试", async () => {
    const collector = new RequestMetricsCollector();
    const send = vi.fn(() => new AssistantMessageEventStream());
    const stream = collector.wrap(makeExamStreamFn({ streamSimple: send } as unknown as Models, { timeoutMs: 20 }))(model, { messages: [] }) as AssistantMessageEventStream;
    await expect(drain(stream)).rejects.toThrow("STREAM_IDLE_TIMEOUT");
    expect(collector.snapshot().requests[0]).toMatchObject({ status: "failed", usage: emptyUsage() });
    expect(collector.snapshot().requests[0]!.endedAt).not.toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });

  it("心跳不算首输出，推理和正文分别计时；回调不复制正文且不重复请求", async () => {
    const collector = new RequestMetricsCollector();
    collector.setThinkingLevel("low");
    const source = new AssistantMessageEventStream();
    let options!: SimpleStreamOptions;
    const inner = vi.fn((_m, _c, o) => { options = o; return source; });
    const stream = collector.wrap(inner)(model, { messages: [] }, { onPayload: () => ({ reasoning_effort: "high", messages: ["private input"] }) }) as AssistantMessageEventStream;
    const result = drain(stream);
    await options.onPayload!({}, model);
    await options.onProviderStreamEvent!({ heartbeat: true }, model);
    expect(collector.snapshot().requests[0]!.firstOutputMs).toBeNull();
    const partial = fauxAssistantMessage("B");
    source.push({ type: "thinking_delta", contentIndex: 0, delta: "think", partial });
    await new Promise<void>((done) => setImmediate(done));
    expect(collector.snapshot().requests[0]!.firstOutputMs).not.toBeNull();
    expect(collector.snapshot().requests[0]!.firstTextMs).toBeNull();
    source.push({ type: "text_delta", contentIndex: 0, delta: "B", partial });
    source.push({ type: "done", reason: "stop", message: partial });
    await result;
    const metric = collector.snapshot().requests[0]!;
    expect(metric.firstTextMs).toBeGreaterThanOrEqual(metric.firstOutputMs!);
    expect(metric).toMatchObject({ requestedThinkingLevel: "low", sentThinking: "high", reportedThinkingLevel: null });
    expect(metric.usage.output).toBeNull();
    expect(JSON.stringify(metric)).not.toContain("private input");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("结果读取路径和失败路径均结束指标记录，不启动第二次请求", async () => {
    const collector = new RequestMetricsCollector();
    const source = new AssistantMessageEventStream();
    source.push({ type: "done", reason: "stop", message: fauxAssistantMessage("B") });
    let captured: SimpleStreamOptions | undefined;
    const inner = vi.fn((_m, _c, options) => { captured = options; return source; });
    const stream = collector.wrap(inner)({ ...model, api: "openai-completions" }, { messages: [] }) as AssistantMessageEventStream;
    await stream.result();
    expect(collector.snapshot().requests[0]!.status).toBe("completed");
    await captured!.onProviderStreamEvent!({ usage: { prompt_tokens: 9999, completion_tokens: 9999 } }, model);
    expect(collector.snapshot().requests[0]!.usage.output).toBeNull();
    const failure = collector.wrap(() => { throw new Error("offline failure"); });
    expect(() => failure(model, { messages: [] })).toThrow("offline failure");
    expect(collector.snapshot().requests[1]!.status).toBe("failed");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("真实 SDK 读取本地 HTTP/SSE usage，SDK 补出的 reasoning=0 不冒充供应商零值", async () => {
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choices: unknown[], usage?: unknown) => res.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "offline", choices, ...(usage ? { usage } : {}) })}\n\n`);
      chunk([{ index: 0, delta: { role: "assistant", content: "B" }, finish_reason: null }]);
      chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
      chunk([], { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } });
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing local TCP address");
      const local = { ...model, api: "openai-completions" as const, baseUrl: `http://127.0.0.1:${address.port}/v1` };
      const collector = new RequestMetricsCollector();
      const stream = collector.wrap(makeExamStreamFn({ streamSimple } as unknown as Models, { timeoutMs: 2000 }))(local,
        { messages: [{ role: "user", content: "offline fixture", timestamp: Date.now() }] }, { apiKey: "offline-placeholder" }) as AssistantMessageEventStream;
      await drain(stream);
      const metric = collector.snapshot().requests[0]!;
      expect(metric.usage).toMatchObject({ input: 100, output: 10, cacheRead: 0, reasoning: null, cacheWrite: null, totalTokens: 110 });
      expect(metric.usageSource).toBe("native");
      expect(metric.firstTextMs).not.toBeNull();
      expect(calls).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

it("并发两模式经过真实 Agent/存档/报告/TUI；续跑不新增模型请求", async () => {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "metrics-verification-"));
  const datasetDir = join(root, "datasets", "demo");
  mkdirSync(join(datasetDir, "public"), { recursive: true });
  mkdirSync(join(datasetDir, "scoring"));
  for (const id of ["q1", "q2"]) writeFileSync(join(datasetDir, "public", `${id}.md`), `---\nid: ${id}\nversion: "1"\nsubject: math\nanswer_kind: single_choice\n---\n\n2+2=? A.3 B.4\n`);
  const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text"], contextWindow: 4096, maxTokens: 1024 }] });
  const faux = fauxProvider();
  // faux 在流出时自行估算 usage，单字母答卷每次返回 1 个输出 Token；不冒充真实接口统计。
  faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("B")));
  const models = createModels();
  models.setProvider(faux.provider);
  const cfg = { datasetsRoot: join(root, "datasets"), modelsConfigPath: "unused", runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  const params = { ...cfg, datasetDir, datasetId: "demo", modes: ["without_tool", "with_tool"] as Array<"without_tool" | "with_tool">, profileId: "faux", modelId: "faux-1", limit: 2, concurrency: 2 };
  const service = new TaskControlService();
  const id = service.start(params);
  const status = (await service.whenDone(id))!;
  expect(status.state).toBe("done");
  expect(status.telemetry!.summary.tokens.output.value).toBe(2);
  expect(status.telemetry!.summary.requests).toBe(2);
  expect(status.telemetry!.questions.map((question) => question.state)).toEqual(["completed", "completed"]);
  for (const runId of status.runIds) {
    const mode = readManifest(cfg.runsRoot, runId)!.mode;
    const detail = await new TaskControlService().getValidatedTaskDetail(cfg.runsRoot, runId, datasetDir, "demo", mode);
    expect(detail.questions).toHaveLength(2);
    expect(detail.questions[0]!.metrics!.requests[0]!.requestedThinkingLevel).toBe("off");
    expect(detail.report!.metrics!.summary.tokens.output.value).toBe(2);
    const source = readManifest(cfg.runsRoot, runId)!.sources[0]!;
    const events = readFileSync(join(cfg.runsRoot, source.runId, "trials", source.trialId, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"request_metrics"');
    expect(events).toContain('"type":"trial_metrics"');
  }
  await prepareMascotImage();
  const tui = new ExamTui(cfg, service);
  vi.spyOn(tui, "getState").mockReturnValue({ screen: { kind: "run", taskId: id }, datasets: [], events: status.events });
  const app = new ExamApp(tui);
  const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  try {
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
    const lines = app.render(80);
    expect(stripTerminalSequences(lines.join("\n"))).toContain("TPS 请求均速");
    expect(stripTerminalSequences(lines.join("\n"))).toContain("推理请求 off");
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    app.handleInput("\x1b[B");
    expect(stripTerminalSequences(app.render(80).join("\n"))).toContain("q2 · 已完成");
    app.handleInput("\r");
    await new Promise<void>((done) => setImmediate(done));
    const expanded = stripTerminalSequences(app.render(80).join("\n"));
    expect(expanded).toContain("request-1");
    expect(expanded).toContain("服务端推理回执 未确认");
    expect(expanded).toContain("TPS(含等待)");
    expect(expanded).toContain("所选题推理请求 off");
    app.handleInput("\x1b");
    expect(stripTerminalSequences(app.render(80).join("\n"))).toContain("逐题状态");
    writeFileSync(join(root, "view-events.json"), JSON.stringify(status.events));
  } finally {
    app.dispose();
    if (rows) Object.defineProperty(process.stdout, "rows", rows);
    else Reflect.deleteProperty(process.stdout, "rows");
  }
  const resumed = (await service.whenDone(service.start(params)))!;
  expect(resumed.state).toBe("done");
  expect(resumed.telemetry!.summary.requests).toBe(0);
  expect(resumed.telemetry!.questions.every((question) => question.reused)).toBe(true);
  expect(faux.state.callCount).toBe(4);
});
