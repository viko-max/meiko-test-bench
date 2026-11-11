import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AssistantMessageEventStream, createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ChatService } from "../src/service/chat-service.js";
import { ChatConfigSchema, type ChatConfig, type ChatSession } from "../src/shared/chat.js";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { sha256OfJsonable } from "../src/shared/hashing.js";
import * as json from "../src/shared/json.js";
import { BatchTokenBudget } from "../src/runner/batch-budget.js";

// 只构造确定的外部提供方响应；Pi Agent、请求保护、指标、预算和磁盘存储均使用生产实现。
function reply(text: string) {
  return fauxAssistantMessage(text);
}
function fixture(patch: Partial<ChatConfig> = {}, contextWindow = 32768, tokensPerSecond?: number) {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "chat-service-"));
  const faux = fauxProvider({ provider: "chat-test", tokensPerSecond, models: [{ id: "text-a", contextWindow, maxTokens: 4096, reasoning: true }, { id: "text-b", contextWindow, maxTokens: 4096, reasoning: true }] });
  const models = createModels(); models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "chat-test", provider: "chat-test", displayName: "离线对话提供方", api: "faux", baseUrl: "https://offline.example/v1", auth: { envVars: ["OFFLINE_CHAT_SERVICE_KEY"] },
    models: ["text-a", "text-b"].map((id) => ({ id, name: id, input: ["text"], reasoning: true, contextWindow, maxTokens: 4096 })) });
  const registry = { models, profilesById: new Map([[profile.id, profile]]) };
  const config = ChatConfigSchema.parse({ profileId: profile.id, modelId: "text-a", maxTotalTokens: 50000, maxOutputTokens: 256, requestTimeoutMs: 1000, turnTimeoutMs: 5000, ...patch });
  const service = new ChatService(join(root, "chats")), session = service.create(config.maxTotalTokens);
  const authorization = (cfg = config, history = service.get(session.id)) => ({ authorisePaid: true as const, modelIdentity: service.selection(cfg, registry).snapshot.identity, historyDigest: sha256OfJsonable(history) });
  const send = (input = "第一条离线消息", cfg = config) => service.respond(session.id, input, cfg, registry, authorization(cfg));
  return { root, faux, registry, config, service, session, authorization, send };
}

describe("独立文本聊天服务", () => {
  it("百万上下文模型的短聊天可使用一万 Token 预算，测评默认预留策略保持原状", async () => {
    const s = fixture({ maxTotalTokens: 10000, maxOutputTokens: 1024 }, 1000000);
    const model = s.registry.models.getModel("chat-test", "text-a")!;
    const legacy = new BatchTokenBudget(join(s.root, "exam-budget.json"), 10000, false);
    let denied = false;
    const guarded = legacy.wrap(() => { throw new Error("不应发送测评请求"); }, { runId: "offline", trialId: "offline", questionId: "offline" }, () => { denied = true; });
    expect(() => guarded(model, { messages: [{ role: "user", content: "简短消息", timestamp: Date.now() }] }, { maxTokens: 1024 })).toThrow("请求未发送");
    expect(denied).toBe(true); expect(legacy.snapshot().reservedTokens).toBe(0);
    s.faux.setResponses([reply("短聊天正常返回")]);
    const result = await s.send("简短消息");
    expect(result.turns[0]?.status).toBe("completed"); expect(result.turns[0]?.model.contextWindow).toBe(1000000);
    expect(s.faux.state.callCount).toBe(1); expect(s.service.budget(result.id)?.entries[0]?.reserved).toBeLessThan(10000);
    expect(s.service.budget(result.id)?.knownTokens).toBe(result.turns[0]?.response?.usage.totalTokens);
  });
  it("真实 Pi 两轮聊天保留上下文，独立保存历史、预算和指标", async () => {
    const s = fixture(); const contexts: string[] = []; let options: SimpleStreamOptions | undefined;
    s.faux.setResponses([(context, value) => { contexts.push(JSON.stringify(context)); options = value; return reply("第一轮回答"); },
      (context) => { contexts.push(JSON.stringify(context)); return reply("第二轮回答"); }]);
    const first = await s.send("说明动量守恒"); const second = await s.send("请接着举例");
    expect(s.faux.state.callCount).toBe(2); expect(first.turns[0]?.status).toBe("completed"); expect(second.turns).toHaveLength(2);
    expect(contexts[1]).toContain("说明动量守恒"); expect(contexts[1]).toContain("第一轮回答");
    expect(contexts.join("")).not.toContain("propose_question"); expect(contexts.join("")).not.toContain("ANYSEARCH");
    expect(options?.maxRetries).toBe(0); expect(options?.maxTokens).toBe(256); expect(options?.signal).toBeInstanceOf(AbortSignal);
    const reported = second.turns.reduce((sum, turn) => sum + turn.response!.usage.totalTokens, 0);
    expect(reported).toBeGreaterThan(first.turns[0]!.response!.usage.totalTokens);
    expect(s.service.budget(second.id)?.entries).toHaveLength(2); expect(s.service.budget(second.id)?.knownTokens).toBe(reported);
    expect(s.service.metrics(second).tokens.totalTokens.value).toBe(reported);
    expect(new ChatService(join(s.root, "chats")).get(second.id)).toEqual(second);
    expect(s.service.list()[0]?.id).toBe(second.id); expect(existsSync(join(s.root, "runs"))).toBe(false);
  });
  it("同一会话切换模型保留原模型标签、上下文和已用额度", async () => {
    const s = fixture(); let context = "";
    s.faux.setResponses([reply("来自模型 A"), (value) => { context = JSON.stringify(value); return reply("来自模型 B"); }]);
    await s.send(); const switched = { ...s.config, modelId: "text-b", thinkingLevel: "high" as const };
    const result = await s.send("使用另一模型继续", switched);
    expect(result.turns.map((turn) => turn.model.modelId)).toEqual(["text-a", "text-b"]);
    expect(result.turns[1]?.config.thinkingLevel).toBe("high"); expect(context).toContain("来自模型 A");
    expect(s.service.budget(result.id)?.knownTokens).toBe(result.turns.reduce((sum, turn) => sum + turn.response!.usage.totalTokens, 0)); expect(s.service.budget(result.id)?.maxTotalTokens).toBe(50000);
    await expect(s.send("不允许重置预算", { ...switched, maxTotalTokens: 100000 })).rejects.toThrow("预算已固定");
    expect(s.faux.state.callCount).toBe(2);
  });
  it("无授权、模型配置变化和旧历史摘要都在请求前拒绝", async () => {
    const s = fixture(); const consent = s.authorization();
    await expect(s.service.respond(s.session.id, "未授权", s.config, s.registry, { ...consent, authorisePaid: false } as any)).rejects.toThrow("确认");
    await expect(s.service.respond(s.session.id, "配置变化", s.config, s.registry, { ...consent, modelIdentity: "old" })).rejects.toThrow("配置已变化");
    s.faux.setResponses([reply("完成")]); await s.send();
    await expect(s.service.respond(s.session.id, "旧页面重复提交", s.config, s.registry, consent)).rejects.toThrow("聊天记录已变化");
    expect(s.faux.state.callCount).toBe(1);
  });
  it("长上下文明确拒绝，不删减历史，不发送请求", async () => {
    const s = fixture({ maxOutputTokens: 128 }, 1024);
    await expect(s.send("上下文材料".repeat(1000))).rejects.toThrow("上下文容量不足");
    expect(s.faux.state.callCount).toBe(0); expect(s.service.get(s.session.id).turns).toHaveLength(0);
  });
  it("会话预算不足不会发请求，保留本地失败记录", async () => {
    const s = fixture({ maxTotalTokens: 1 }); const result = await s.send();
    expect(s.faux.state.callCount).toBe(0); expect(result.turns[0]?.requestStarted).toBe(false);
    expect(result.turns[0]?.status).toBe("error"); expect(result.turns[0]?.error).toContain("额度不足");
    expect(s.service.budget(result.id)?.entries).toHaveLength(0);
    expect(s.service.metrics(result).requests).toBe(0);
  });
  it("同会话重复发送和跨实例并发均拒绝；取消后不继续计费", async () => {
    const s = fixture(); let entered = false;
    s.faux.setResponses([async (_context, options) => { entered = true; await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("offline cancelled")), { once: true })); return reply("不能继续发送"); }]);
    const pending = s.send(); await vi.waitFor(() => expect(entered).toBe(true));
    await expect(s.send("重复发送")).rejects.toThrow("正在回复");
    const second = new ChatService(join(s.root, "chats"));
    await expect(second.respond(s.session.id, "另一个实例", s.config, s.registry, s.authorization())).rejects.toThrow("execution refused");
    s.service.cancel(s.session.id); const result = await pending;
    expect(result.turns[0]?.status).toBe("cancelled"); expect(s.faux.state.callCount).toBe(1);
    await expect(s.send()).rejects.toThrow("上次对话未完整完成");
  });
  it("空闲流超时诚实保存未知结果，不自动重发", async () => {
    const s = fixture({ requestTimeoutMs: 50 });
    s.faux.setResponses([async (_context, options) => { await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("offline idle")), { once: true })); return reply("不会执行"); }]);
    const result = await s.send(); expect(result.turns[0]?.status).toBe("outcome_unknown");
    expect(s.faux.state.callCount).toBe(1); expect(s.service.budget(result.id)?.unknownRequests).toBe(1);
    await expect(s.send()).rejects.toThrow("上次对话未完整完成");
  });
  it("供应商未提供用量时显示未知，不能按零消耗继续", async () => {
    const s = fixture(); const message = reply("有正文，无用量证据");
    message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); stream.end(message);
    const spy = vi.spyOn(s.registry.models, "streamSimple").mockReturnValue(stream);
    try {
      const result = await s.send();
      expect(result.turns[0]?.status).toBe("outcome_unknown"); expect(s.service.metrics(result).tokens.totalTokens.value).toBeNull();
      expect(s.service.budget(result.id)?.unknownRequests).toBe(1); expect(spy).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });
  it("未开放的工具不会执行或引发第二次模型调用", async () => {
    const s = fixture(), message = reply(""); message.content = [fauxToolCall("execute_python", { code: "raise Exception('must not execute')" })]; message.stopReason = "toolUse";
    s.faux.setResponses([message]); const result = await s.send();
    expect(s.faux.state.callCount).toBe(1); expect(result.turns[0]?.status).not.toBe("completed");
  });
  it("输出截断保留文本和真实状态，下一条由用户显式发送", async () => {
    const s = fixture(), message = reply("截断的实际正文"); message.stopReason = "length";
    s.faux.setResponses([message, reply("显式继续")]); const first = await s.send();
    expect(first.turns[0]?.status).toBe("truncated"); expect(first.turns[0]?.response?.content[0]?.text).toBe("截断的实际正文");
    expect(s.faux.state.callCount).toBe(1); expect((await s.send("请继续")).turns).toHaveLength(2);
  });
  it("最终存档失败可补存原结果，不补发请求", async () => {
    const s = fixture(); s.faux.setResponses([reply("已收到的真实离线响应")]);
    const original = json.writeJsonAtomic, spy = vi.spyOn(json, "writeJsonAtomic").mockImplementation((path, value) => {
      if ((value as ChatSession).schema === "meiko-chat/1" && (value as ChatSession).turns.at(-1)?.status === "completed") throw new Error("offline archive failure");
      return original(path, value);
    });
    try { await expect(s.send()).rejects.toThrow("offline archive failure"); expect(s.faux.state.callCount).toBe(1); }
    finally { spy.mockRestore(); }
    s.service.flush(); expect(s.service.get(s.session.id).turns[0]?.status).toBe("completed"); expect(s.faux.state.callCount).toBe(1);
  });
  it("凭据文本被拒绝，供应商回显凭据不会进入历史或错误", async () => {
    const s = fixture(); const secret = "offline-chat-only-sensitive-value"; vi.stubEnv("OFFLINE_CHAT_SERVICE_KEY", secret);
    try {
      await expect(s.send(secret)).rejects.toThrow("凭据"); expect(s.faux.state.callCount).toBe(0);
      s.faux.setResponses([reply(secret)]); await s.send("请正常回答");
      expect(readFileSync(join(s.root, "chats", s.session.id, "session.json"), "utf8")).not.toContain(secret);
      expect(s.service.safeError(new Error(secret))).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); }
  });
  it("非法会话路径在读取前拒绝", () => {
    const s = fixture(); expect(() => s.service.get("../runs")).toThrow(); expect(() => s.service.budget("../runs")).toThrow();
  });
  it("空正文不会被标为完整回复", async () => {
    const s = fixture(); s.faux.setResponses([reply("")]); const result = await s.send();
    expect(result.turns[0]?.status).toBe("error"); expect(result.turns[0]?.error).toContain("空正文"); expect(s.faux.state.callCount).toBe(1);
  });
  it("正常长文本不会因为错误信息长度限制而在显示前被截断", () => {
    const s = fixture(), text = "完整聊天正文".repeat(600) + "全文结束标记";
    expect(s.service.redact(text)).toBe(text);
  });
  it("接口地址中的用户名、密码或凭据参数在请求前拒绝", () => {
    const s = fixture(), model = s.registry.models.getModel("chat-test", "text-a")!;
    model.baseUrl = "https://fixture:fixture@example.org/v1";
    expect(() => s.service.selection(s.config, s.registry)).toThrow("接口地址不能包含凭据");
    model.baseUrl = "https://example.org/v1?token=fixture";
    expect(() => s.service.selection(s.config, s.registry)).toThrow("接口地址不能包含凭据"); expect(s.faux.state.callCount).toBe(0);
  });
  it("中途停止流式回复仍保留已经显示的文本", async () => {
    const s = fixture({}, 32768, 50); s.faux.setResponses([reply("逐步返回的正文。".repeat(100))]);
    const pending = s.send();
    try {
      await vi.waitFor(() => expect(s.service.live(s.session.id).length).toBeGreaterThan(0), { timeout: 2000 });
      const shown = s.service.live(s.session.id); s.service.cancel(s.session.id); const result = await pending;
      const turn = result.turns[0]!;
      expect(turn.status).toBe("cancelled"); expect(turn.response?.content.map((part) => part.text).join("") || turn.partialText).toContain(shown);
      expect(s.faux.state.callCount).toBe(1);
    } finally { s.service.cancel(s.session.id); await pending; }
  });
});
