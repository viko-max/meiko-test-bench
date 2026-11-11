import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { ChatConfigSchema, ChatIdSchema, ChatSessionSchema, type ChatConfig, type ChatModel, type ChatSession, type ChatTurn } from "../shared/chat.js";
import type { CapabilityState } from "../shared/contracts.js";
import { assertNoCredentials } from "../shared/creds.js";
import { sha256OfJsonable } from "../shared/hashing.js";
import { writeJsonAtomic } from "../shared/json.js";
import { summarizeRequests } from "../shared/metrics.js";
import { resolveModel, type Registry } from "../providers/pi-adapter.js";
import { resolveApiKeyFromEnv } from "../providers/models-config.js";
import { makeExamStreamFn } from "../providers/stream-fn.js";
import { capOutputPayload } from "../providers/output-cap.js";
import { injectSparkNativeSearch, sparkNativeSearchSupport } from "../providers/spark-native-search.js";
import { contextBudget } from "../runner/context-budget.js";
import { BatchTokenBudget, readBudget } from "../runner/batch-budget.js";
import { withExecutionLease } from "../runner/execution-lock.js";
import { RequestMetricsCollector } from "../runner/request-metrics.js";
import { resolvePublicAttachment, resolveWithin } from "../tools/paths.js";

const SYSTEM = "你是 Meiko Test-Bench 的普通对话助手。按用户使用的语言回答学习、研究和一般讨论。当前仅提供文本对话，没有搜索、文件读取或代码执行工具。不要声称已访问网络、题库、项目文件或未提供的附件。";
const SYSTEM_NATIVE_SEARCH = "你是 Meiko Test-Bench 的普通对话助手。按用户使用的语言回答学习、研究和一般讨论。当前允许使用供应商提供的原生网络搜索，是否搜索以及搜索什么由模型自行决定；你没有本地搜索、文件读取或代码执行工具。不要声称已访问题库、项目文件或未提供的附件。只有回复中确有检索结果时才可以说明信息来源，不要编造来源。";
const now = () => new Date().toISOString();
type Active = { controller: AbortController; agent?: Agent; text: string };

export class ChatService {
  private readonly active = new Map<string, Active>();
  private readonly unsaved = new Map<string, ChatSession>();
  private readonly listeners = new Set<() => void>();
  private readonly secrets = new Set<string>();
  constructor(private readonly root: string) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  live(id: string): string { return this.active.get(id)?.text ?? ""; }
  private directory(id: string): string {
    ChatIdSchema.parse(id);
    const dir = resolveWithin(this.root, id);
    if (existsSync(dir) && realpathSync(dir) !== join(realpathSync(resolve(this.root)), id)) throw new Error("聊天目录发生路径跳转，已拒绝访问。");
    return dir;
  }
  private guard(value: unknown): void {
    assertNoCredentials(value, "chat data");
    const text = JSON.stringify(value);
    for (const secret of this.secrets) if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))) throw new Error("聊天内容包含当前模型凭据，已拒绝发送或保存。");
  }
  redact(text: string): string {
    for (const secret of this.secrets) text = text.replaceAll(secret, "[已隐藏]");
    try { assertNoCredentials(text, "chat display"); return text; }
    catch { return "内容含疑似敏感信息，已隐藏；请检查输入或调用记录。"; }
  }
  safeError(error: unknown): string {
    return this.redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
  }
  private save(session: ChatSession): void {
    const checked = ChatSessionSchema.parse(session); this.guard(checked);
    this.unsaved.set(session.id, checked);
    try { writeJsonAtomic(join(this.directory(session.id), "session.json"), checked); this.unsaved.delete(session.id); }
    catch (error) { this.active.get(session.id)?.controller.abort(); throw error; }
    this.notify();
  }
  flush(): void { for (const session of [...this.unsaved.values()]) this.save(session); }
  get(id: string): ChatSession {
    const session = this.unsaved.get(id) ?? ChatSessionSchema.parse(JSON.parse(readFileSync(resolvePublicAttachment(this.directory(id), "session.json"), "utf8")));
    if (session.id !== id) throw new Error("聊天记录标识与目录不一致。");
    this.guard(session);
    const result = structuredClone(session), last = result.turns.at(-1);
    if (last?.status === "running" && !this.active.has(id)) { last.status = "outcome_unknown"; last.error = "上次请求未完整结束，当前进程无法确认结果；未自动重新发送。"; }
    return result;
  }
  list(): ChatSession[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((id) => ChatIdSchema.safeParse(id).success && existsSync(join(this.root, id, "session.json")))
      .map((id) => this.get(id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  create(maxTotalTokens: number): ChatSession {
    const at = now();
    const session = ChatSessionSchema.parse({ schema: "meiko-chat/1", id: `chat-${randomUUID()}`, title: "新对话", createdAt: at, updatedAt: at, maxTotalTokens, turns: [] });
    this.save(session); return structuredClone(session);
  }
  budget(id: string) {
    const path = join(this.directory(id), "budget.json");
    return existsSync(path) ? readBudget(path) : null;
  }
  selection(config: ChatConfig, registry: Registry, requireCredentials = false) {
    ChatConfigSchema.parse(config);
    for (const profile of registry.profilesById.values()) for (const name of profile.auth.envVars) if (process.env[name]) this.secrets.add(process.env[name]!);
    const model = resolveModel(registry, config.profileId, config.modelId), profile = registry.profilesById.get(config.profileId);
    if (!model || !profile || !model.input.includes("text") || profile.capability.text === "unsupported") throw new Error("所选模型不可用或不支持文本输入，请重新选择。");
    if (!getSupportedThinkingLevels(model).includes(config.thinkingLevel)) throw new Error("模型不支持所选推理等级，请重新选择。");
    if (config.nativeSearch) {
      const support = this.nativeSearchSupport(config, registry);
      if (!support.supported) throw new Error(`所选模型不支持供应商原生网络搜索：${support.reason ?? "未说明原因"}`);
    }
    if (requireCredentials && profile.api !== "faux" && !resolveApiKeyFromEnv(profile.auth.envVars)) throw new Error(`模型凭据未配置，请设置 ${profile.auth.envVars.join(" 或 ")} 后启动。`);
    const endpoint = new URL(model.baseUrl);
    if (endpoint.username || endpoint.password || [...endpoint.searchParams.keys()].some((key) => ["key", "api_key", "apikey", "token", "access_token"].includes(key.toLowerCase()))) throw new Error("模型接口地址不能包含凭据；请通过配置中的环境变量提供。");
    this.guard(profile);
    const snapshot: ChatModel = { profileId: config.profileId, modelId: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, identity: sha256OfJsonable({ profile, model }) };
    return { model, snapshot, profile };
  }
  /** 当前模型档案是否允许打开供应商原生网络搜索（供 TUI 显示与拦截）。 */
  nativeSearchSupport(config: ChatConfig, registry: Registry): { supported: boolean; status: CapabilityState; reason: string | null } {
    const profile = registry.profilesById.get(config.profileId);
    const status: CapabilityState = profile?.capability.nativeWebSearch ?? "unverified";
    const support = sparkNativeSearchSupport(profile, config.modelId);
    return { supported: support.supported, status: support.supported ? "verified" : status, reason: support.reason };
  }
  private systemPrompt(config: ChatConfig): string {
    return config.nativeSearch ? SYSTEM_NATIVE_SEARCH : SYSTEM;
  }
  private messages(config: ChatConfig, session?: ChatSession): Message[] {
    const history: Message[] = [{ role: "system", content: this.systemPrompt(config), timestamp: 0 }];
    for (const turn of session?.turns ?? []) {
      if (!turn.requestStarted) continue;
      history.push({ role: "user", content: turn.input, timestamp: Date.parse(turn.startedAt) });
      if (turn.response) history.push(structuredClone(turn.response) as AssistantMessage);
    }
    return history;
  }
  context(config: ChatConfig, registry: Registry, session?: ChatSession, input = "") {
    const { model } = this.selection(config, registry);
    const messages = this.messages(config, session);
    if (input) messages.push({ role: "user", content: input, timestamp: Date.now() });
    return contextBudget(model, messages, config.maxOutputTokens);
  }
  metrics(session?: ChatSession) {
    const turns = (session?.turns ?? []).filter((turn) => turn.requestStarted);
    return summarizeRequests(turns.flatMap((turn) => (turn.metrics?.requests ?? []).map((request) => ({ ...request, id: `${turn.id}:${request.id}` }))),
      turns.reduce((sum, turn) => sum + (turn.metrics?.elapsedMs ?? 0), 0));
  }
  cancel(id: string): void { const active = this.active.get(id); active?.controller.abort(); active?.agent?.abort(); }

  async respond(id: string, input: string, config: ChatConfig, registry: Registry,
    authorization: { authorisePaid: true; modelIdentity: string; historyDigest: string }): Promise<ChatSession> {
    if (authorization?.authorisePaid !== true) throw new Error("首次对话或更换配置后，需要先确认模型、接口和独立预算。");
    if (!input.trim() || input.length > 20000) throw new Error("请输入 1–20000 字符的消息。");
    const selected = this.selection(config, registry, true); this.guard(input);
    const nativeSearch = config.nativeSearch === true && selected.profile.capability.nativeWebSearch === "verified";
    if (selected.snapshot.identity !== authorization.modelIdentity) throw new Error("模型接口配置已变化，请重新确认发送。");
    if (this.active.has(id)) throw new Error("该对话正在回复，请等待或停止，不能重复发送。");
    const active: Active = { controller: new AbortController(), text: "" }; this.active.set(id, active);
    try {
      return await withExecutionLease(async () => {
        const session = this.get(id), last = session.turns.at(-1);
        if (sha256OfJsonable(session) !== authorization.historyDigest) throw new Error("聊天记录已变化，请重新读取后发送。");
        if (session.maxTotalTokens !== config.maxTotalTokens) throw new Error("会话预算已固定；更换模型不会重置已用额度。");
        if (last?.requestStarted && !["completed", "truncated"].includes(last.status)) throw new Error("上次对话未完整完成，请检查记录；不会自动续发，请明确新建会话。");
        if (this.context(config, registry, session, input).remainingTokens < 0) throw new Error("上下文容量不足，消息未发送。请新建会话；历史消息没有被删减。");
        const budgetPath = join(this.directory(id), "budget.json");
        if (session.turns.some((turn) => turn.requestStarted) && !existsSync(budgetPath)) throw new Error("会话预算记录缺失，拒绝将已用额度重置为零。");
        const budget = new BatchTokenBudget(budgetPath, session.maxTotalTokens, existsSync(budgetPath));
        if (budget.snapshot().blocked) throw new Error("会话额度不足或用量未知，未发送新请求。请检查记录或新建会话。");
        const turn: ChatTurn = { id: randomUUID(), input: input.trim(), startedAt: now(), status: "running", requestStarted: false, config: structuredClone(config), model: selected.snapshot };
        const history = this.messages(config, session).slice(1);
        session.turns.push(turn); session.updatedAt = now(); if (session.turns.length === 1) session.title = [...input.trim()].slice(0, 60).join("");
        this.save(session);
        const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(config.turnTimeoutMs)]);
        const base = makeExamStreamFn(registry.models, { timeoutMs: config.requestTimeoutMs, maxTokens: config.maxOutputTokens });
        let issued = false, denied = false;
        const raw: StreamFn = (model, context, options) => {
          if (signal.aborted || issued) throw new Error("请求已停止或本轮已发送，不重复调用。");
          this.guard(context.messages); turn.requestStarted = true; this.save(session); issued = true;
          return base(model, context, { ...options, signal, maxRetries: 0 });
        };
        const budgeted = budget.wrap(raw, { runId: id, trialId: turn.id, questionId: "chat" }, () => { denied = true; }, "inputTokens");
        const metrics = new RequestMetricsCollector(() => { turn.metrics = metrics.snapshot(); this.save(session); });
        metrics.setThinkingLevel(config.thinkingLevel);
        const stream = metrics.wrap(budgeted), maxTokens = Math.min(config.maxOutputTokens, selected.model.maxTokens);
        const agent = new Agent({ initialState: { systemPrompt: this.systemPrompt(config), model: selected.model, tools: [], thinkingLevel: config.thinkingLevel, messages: history },
          streamFn: (model, context, options) => stream(model, context, { ...options, signal, maxTokens }),
          onPayload: (payload) => {
            const capped = capOutputPayload(payload, maxTokens);
            return nativeSearch ? injectSparkNativeSearch(capped) : capped;
          },
          prepareRequest: (request) => {
            if (signal.aborted || issued) throw new Error("本轮已停止或已发送，不自动追加请求。");
            if (contextBudget(request.model, request.context.messages as Message[], maxTokens).remainingTokens < 0) throw new Error("上下文容量不足，未删除消息，也未发送请求。");
          },
          beforeToolCall: async () => ({ block: true, reason: "普通对话未开放工具。", terminate: true }),
          finishTurn: () => ({ action: "end" }),
        });
        active.agent = agent;
        const unsubscribe = agent.subscribe((event) => {
          if (event.type !== "message_update" || event.message.role !== "assistant") return;
          const text = event.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
          try { this.guard(text); active.text = text; }
          catch { active.text = "返回内容含敏感信息，已隐藏。"; active.controller.abort(); }
          this.notify();
        });
        const abort = () => agent.abort(); signal.addEventListener("abort", abort, { once: true });
        try {
          if (signal.aborted) throw new Error("对话已取消，未发送请求。");
          await agent.prompt(input.trim()); await agent.waitForIdle();
          const answer = [...agent.state.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
          if (answer) {
            turn.response = { role: "assistant", content: answer.content.flatMap((part) => part.type === "text" ? [{ type: "text" as const, text: part.text }] : []),
              api: answer.api, provider: answer.provider, model: answer.model, usage: answer.usage, timestamp: answer.timestamp, stopReason: answer.stopReason };
            this.guard(turn.response);
          }
          if (denied && !issued) { turn.status = "error"; turn.error = "独立会话 Token 额度不足，未发送请求。请降低单次输出上限，或新建会话调整预算。"; }
          else if (active.controller.signal.aborted) { turn.status = "cancelled"; turn.error = "已停止对话；保留本轮记录，不自动重新发送。"; }
          else if (budget.snapshot().unknownRequests) { turn.status = "outcome_unknown"; turn.error = "本轮用量或结果未确认，不自动重发。"; }
          else if (answer?.stopReason === "length") { turn.status = "truncated"; turn.error = "达到输出上限，保留实际返回内容。"; }
          else if (answer?.stopReason !== "stop" || answer.content.some((part) => part.type === "toolCall")) { turn.status = issued ? "outcome_unknown" : "error"; turn.error = this.safeError(answer?.errorMessage ?? "模型未正常结束，未追加请求。"); }
          else if (!turn.response?.content.some((part) => part.text.trim())) { turn.status = "error"; turn.error = "模型返回空正文，本轮记录和实际用量已保留。"; }
          else turn.status = "completed";
        } catch (error) {
          turn.status = active.controller.signal.aborted ? "cancelled" : issued ? "outcome_unknown" : "error";
          turn.error = this.safeError(denied ? "独立会话 Token 额度不足，未发送请求。" : error);
          if (turn.response) { try { this.guard(turn.response); } catch { delete turn.response; } }
        } finally {
          unsubscribe(); signal.removeEventListener("abort", abort);
          if (!turn.response?.content.some((part) => part.text.trim()) && active.text) { try { this.guard(active.text); turn.partialText = active.text; } catch { /* 敏感文本不进入存档。 */ } }
          turn.endedAt = now(); turn.metrics = metrics.snapshot(); session.updatedAt = now(); this.save(session);
        }
        return structuredClone(session);
      });
    } finally { this.active.delete(id); this.notify(); }
  }
}
