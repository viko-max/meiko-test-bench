import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { AssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, type Models, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { makeExamStreamFn, scheduledStreamFn } from "../src/providers/stream-fn.js";
import { RequestScheduler } from "../src/runner/request-scheduler.js";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { runBatch } from "../src/runner/batch.js";
import { EXAM_TOOLS_VERSION } from "../src/tools/index.js";

const model = fauxProvider().getModel();
const context = { messages: [] };

function setup() {
  const sources: AssistantMessageEventStream[] = [];
  const options: SimpleStreamOptions[] = [];
  const send = vi.fn((_m, _c, o) => {
    options.push(o);
    const source = new AssistantMessageEventStream();
    sources.push(source);
    return source;
  });
  const models = { streamSimple: send } as unknown as Models;
  return { sources, options, send, fn: makeExamStreamFn(models, { timeoutMs: 100 }) };
}

async function drain(stream: AssistantMessageEventStream) {
  for await (const _event of stream) { /* 消费真实 Pi 事件协议，不模拟 Harness 返回值。 */ }
  return stream.result();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("流空闲看门狗", () => {
  it("真实 OpenAI SDK 连接本地 SSE 后挂起，空闲超时关闭 HTTP 连接且只发送一次", async () => {
    vi.useRealTimers();
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
    let requests = 0;
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolveClosed) => { closed = resolveClosed; });
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: "offline", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`);
      response.once("close", closed);
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local test server has no TCP address");
      const localModel = { ...model, api: "openai-completions" as const, provider: "offline-http", baseUrl: `http://127.0.0.1:${address.port}/v1` };
      const localModels = { streamSimple } as unknown as Models;
      const stream = makeExamStreamFn(localModels, { timeoutMs: 500 })(localModel, { messages: [{ role: "user", content: "offline test", timestamp: Date.now() }] }, { apiKey: "offline-placeholder" }) as AssistantMessageEventStream;
      const events: string[] = [];
      const consume = (async () => {
        for await (const event of stream) events.push(event.type);
      })();
      await expect(consume).rejects.toThrow("STREAM_IDLE_TIMEOUT");
      expect(events).toContain("text_delta");
      await Promise.race([connectionClosed, new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SDK did not close the local HTTP connection")), 1000);
        void connectionClosed.then(() => clearTimeout(timer));
      })]);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("没有首个事件且适配器忽略 abort 时，result 等待也能结束", async () => {
    const s = setup();
    const stream = s.fn(model, context) as AssistantMessageEventStream;
    const result = expect(stream.result()).rejects.toThrow("STREAM_IDLE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(s.options[0]!.signal!.aborted).toBe(true);
    expect(s.options[0]!.maxRetries).toBe(0);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("已连接并输出部分内容后挂起，迭代及时退出且不接受迟到的成功", async () => {
    const s = setup();
    const stream = s.fn(model, context) as AssistantMessageEventStream;
    const partial = fauxAssistantMessage("未完成的答卷");
    s.sources[0]!.push({ type: "start", partial });
    const result = expect(drain(stream)).rejects.toThrow("STREAM_IDLE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    s.sources[0]!.push({ type: "done", reason: "stop", message: partial });
    await expect(stream.result()).rejects.toThrow("STREAM_IDLE_TIMEOUT");
    expect(s.options[0]!.signal!.aborted).toBe(true);
  });

  it("推理、文本、工具参数持续更新时，总时长可超过空闲阈值", async () => {
    const s = setup();
    const stream = s.fn(model, context) as AssistantMessageEventStream;
    const partial = fauxAssistantMessage("答案 B");
    s.sources[0]!.push({ type: "start", partial });
    const result = drain(stream);
    for (const type of ["thinking_delta", "text_delta", "toolcall_delta"] as const) {
      await vi.advanceTimersByTimeAsync(70);
      s.sources[0]!.push({ type, contentIndex: 0, delta: "x", partial });
      await vi.advanceTimersByTimeAsync(0);
    }
    s.sources[0]!.push({ type: "done", reason: "stop", message: partial });
    expect(await result).toBe(partial);
    expect(s.options[0]!.signal!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("原始流事件也重置计时，并保留调用者的观察回调", async () => {
    const s = setup();
    const onResponse = vi.fn();
    const onProviderStreamEvent = vi.fn();
    const stream = s.fn(model, context, { onResponse, onProviderStreamEvent }) as AssistantMessageEventStream;
    const result = stream.result();
    await s.options[0]!.onResponse!({ status: 200, headers: {} }, model);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(70);
      await s.options[0]!.onProviderStreamEvent!({ usage: {} }, model);
    }
    const message = fauxAssistantMessage("B");
    s.sources[0]!.push({ type: "done", reason: "stop", message });
    expect(await result).toBe(message);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onProviderStreamEvent).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("事件迭代结束但没有最终结果时，result 不会永久挂起", async () => {
    const s = setup();
    const stream = s.fn(model, context) as AssistantMessageEventStream;
    s.sources[0]!.end();
    const result = expect(drain(stream)).rejects.toThrow("STREAM_IDLE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });

  it("用户取消立即结束等待，不等待适配器响应", async () => {
    const s = setup();
    const controller = new AbortController();
    const stream = s.fn(model, context, { signal: controller.signal }) as AssistantMessageEventStream;
    const result = expect(drain(stream)).rejects.toThrow("cancelled by caller");
    controller.abort();
    await result;
    expect(s.options[0]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("调用前已取消时不发送请求", () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    expect(() => s.fn(model, context, { signal: controller.signal })).toThrow("cancelled by caller");
    expect(s.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("初始化错误清理计时器，正常 error 终止保留供应商原因", async () => {
    const s = setup();
    s.send.mockImplementationOnce(() => { throw new Error("setup failed"); });
    expect(() => s.fn(model, context)).toThrow("setup failed");
    expect(vi.getTimerCount()).toBe(0);
    const stream = s.fn(model, context) as AssistantMessageEventStream;
    const error = { ...fauxAssistantMessage(""), stopReason: "error" as const, errorMessage: "provider failure" };
    s.sources[0]!.push({ type: "error", reason: "error", error });
    expect((await drain(stream)).errorMessage).toBe("provider failure");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超时释放请求调度槽，下一道题可运行，挂起请求不重试", async () => {
    const s = setup();
    const scheduled = scheduledStreamFn(s.fn, new RequestScheduler({ maxConcurrent: 1, minIntervalMs: 0 }), () => "same-key");
    const first = expect(drain(scheduled(model, context) as AssistantMessageEventStream)).rejects.toThrow("STREAM_IDLE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(100);
    await first;
    const second = drain(scheduled(model, context) as AssistantMessageEventStream);
    await vi.advanceTimersByTimeAsync(0);
    const message = fauxAssistantMessage("B");
    s.sources[1]!.push({ type: "done", reason: "stop", message });
    expect(await second).toBe(message);
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("真实 Agent 与存档流程将挂起标为 outcome_unknown，续跑零新增请求", async () => {
    vi.useRealTimers();
    const base = resolve(".work");
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, "stream-verification-"));
    mkdirSync(join(root, "public"));
    mkdirSync(join(root, "scoring"));
    writeFileSync(join(root, "public", "q.md"), '---\nid: q\nversion: "1"\nsubject: math\nanswer_kind: single_choice\n---\n\n2+2=? A.3 B.4\n');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let signal: AbortSignal | undefined;
    const send = vi.spyOn(models, "streamSimple").mockImplementation((_m, _c, options) => {
      signal = options!.signal;
      const source = new AssistantMessageEventStream();
      source.push({ type: "start", partial: fauxAssistantMessage("") });
      return source;
    });
    const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }], capability: {} });
    const params = { datasetId: "demo", datasetDir: root, modes: ["with_tool" as const], profileId: "faux", modelId: "faux-1", limit: 1, runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: EXAM_TOOLS_VERSION, pythonInterpreter: "python", modelsConfigPath: "unused", requestTimeoutMs: 20, registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
    const first = await runBatch(params);
    expect(first.byMode.with_tool!.report.perQuestion[0]!.executionStatus).toBe("outcome_unknown");
    expect(signal!.aborted).toBe(true);
    const trialDir = join(params.runsRoot, first.byMode.with_tool!.runId, "trials");
    const trial = JSON.parse(readFileSync(join(trialDir, readdirSync(trialDir)[0]!, "trial.json"), "utf8"));
    expect(trial.errorMessage).toContain("STREAM_IDLE_TIMEOUT");
    const events = readFileSync(join(trialDir, readdirSync(trialDir)[0]!, "events.jsonl"), "utf8");
    expect(events).toContain("STREAM_IDLE_TIMEOUT");
    const resumed = await runBatch({ ...params, resume: true });
    expect(resumed.byMode.with_tool!.report.perQuestion[0]!.executionStatus).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
