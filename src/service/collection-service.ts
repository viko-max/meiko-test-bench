import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, getSupportedThinkingLevels, type Message } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AnySearchClient, ANYSEARCH_COMMIT, ANYSEARCH_VERSION, SearchQuerySchema, type SearchQuery, type SearchDomains } from "../providers/anysearch.js";
import { ANYSEARCH_SKILL } from "../providers/anysearch-skill.js";
import { makeExamStreamFn } from "../providers/stream-fn.js";
import { capOutputPayload } from "../providers/output-cap.js";
import { resolveModel, type Registry } from "../providers/pi-adapter.js";
import { COLLECTION_WORKFLOW_VERSION, CollectionCandidateSchema, CollectionConfigSchema, CollectionSessionSchema, type CollectionCandidateInput, type CollectionConfig, type CollectionSession } from "../shared/collection.js";
import { assertNoCredentials } from "../shared/creds.js";
import { sha256OfJsonable, sha256OfText } from "../shared/hashing.js";
import { writeJsonAtomic } from "../shared/json.js";
import { withExecutionLease } from "../runner/execution-lock.js";
import { BatchTokenBudget, readBudget } from "../runner/batch-budget.js";
import { contextBudget } from "../runner/context-budget.js";
import { assertScoring } from "../grading/scoring.js";
import { ImportService, type DraftDataset } from "../import/import-service.js";
import { mixedScoringContent } from "../import/validation.js";
import { importDataset } from "../dataset/import.js";
import { buildUserContent } from "../runner/prompt.js";
import { resolvePublicAttachment, resolveWithin } from "../tools/paths.js";
import { RequestMetricsCollector } from "../runner/request-metrics.js";
import { collectionCandidateArgs, collectionDomains, collectionProgress, collectionSourceLinks } from "./collection-workflow.js";

const now = () => new Date().toISOString();
const fingerprint = (question: CollectionCandidateInput["question"]) => sha256OfJsonable({
  stem: question.stem.trim().replace(/\s+/g, " "), options: question.options ?? {}, parts: question.parts ?? [], assets: question.assets ?? [],
});
const queryArgs = Type.Object({ query: Type.String(), tag: Type.Optional(Type.String()), params: Type.Optional(Type.Record(Type.String(), Type.String())),
  zone: Type.Optional(Type.Union([Type.Literal("cn"), Type.Literal("intl")])), language: Type.Optional(Type.String()), max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) });
type Active = { controller: AbortController; agent?: Agent; activity?: string; text?: string };

export class CollectionService {
  private readonly active = new Map<string, Active>();
  private readonly unsaved = new Map<string, CollectionSession>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly importRoot: string, private readonly datasetsRoot: string,
    private readonly clientFactory: (config: CollectionConfig) => AnySearchClient = (config) => new AnySearchClient({ apiKeyEnv: config.apiKeyEnv, timeoutMs: config.limits.requestTimeoutMs }),
    private readonly modelApiKey?: () => string | undefined) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  live(id: string): { activity: string; text: string } {
    const active = this.active.get(id); return { activity: active?.activity ?? "等待输入", text: active?.text ?? "" };
  }

  private directory(id: string): string {
    z.string().regex(/^collection-[a-f0-9-]{36}$/).parse(id);
    const dir = resolveWithin(this.importRoot, id);
    if (existsSync(dir) && realpathSync(dir) !== join(realpathSync(resolve(this.importRoot)), id)) throw new Error("搜题会话目录发生路径跳转。");
    return dir;
  }
  private save(session: CollectionSession): void {
    this.unsaved.set(session.id, session);
    try {
      const checked = CollectionSessionSchema.parse(session);
      assertNoCredentials(checked, "collection archive");
      writeJsonAtomic(join(this.directory(session.id), "collection.json"), checked);
      this.unsaved.delete(session.id);
      this.notify();
    } catch (error) {
      // 存档失败不能作为可忽略的工具错误继续计费。
      this.active.get(session.id)?.controller.abort();
      throw error;
    }
  }
  flush(): void {
    for (const session of [...this.unsaved.values()]) this.save(session);
  }
  get(id: string): CollectionSession {
    const session = CollectionSessionSchema.parse(JSON.parse(readFileSync(resolvePublicAttachment(this.directory(id), "collection.json"), "utf8")));
    if (session.id !== id) throw new Error("搜题会话标识与存储位置不一致。");
    assertNoCredentials(session, "collection archive");
    for (const source of session.sources) if (source.digest !== sha256OfText(source.content)) throw new Error("搜题来源内容与摘要不一致。");
    if (session.state === "running" && !this.active.has(id)) return { ...session, state: "outcome_unknown", error: "上次搜题进程未完整结束；保留材料，不自动重发模型请求。" };
    return session;
  }
  list(): CollectionSession[] {
    if (!existsSync(this.importRoot)) return [];
    return readdirSync(this.importRoot).filter((id) => /^collection-[a-f0-9-]{36}$/.test(id) && existsSync(join(this.importRoot, id, "collection.json"))).map((id) => this.get(id));
  }
  private model(config: CollectionConfig, registry: Registry) {
    const model = resolveModel(registry, config.profileId, config.modelId);
    const profile = registry.profilesById.get(config.profileId);
    if (!model || !profile || profile.capability.text === "unsupported" || profile.capability.toolCalling === "unsupported") throw new Error("搜题模型不存在或不支持必要的文本与工具调用。");
    if (!getSupportedThinkingLevels(model).includes(config.thinkingLevel)) throw new Error("搜题模型不支持所选推理等级。");
    assertNoCredentials(profile, "collection model profile");
    return { model, identity: sha256OfJsonable({ profile, skill: ANYSEARCH_COMMIT, workflow: COLLECTION_WORKFLOW_VERSION,
      prompt: sha256OfText(ANYSEARCH_SKILL), candidateSchema: collectionCandidateArgs,
      model: { id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl, input: model.input,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap, samplingParams: model.samplingParams,
        samplingParamsByThinkingLevel: model.samplingParamsByThinkingLevel, compat: model.compat } }) };
  }
  create(goal: string, config: z.input<typeof CollectionConfigSchema>, registry: Registry): CollectionSession {
    const checked = CollectionConfigSchema.parse(config);
    z.string().trim().min(1).max(20000).parse(goal);
    const resolved = this.model(checked, registry);
    const session: CollectionSession = { schema: "meiko-collection/1", id: `collection-${randomUUID()}`, config: checked,
      goal, modelIdentity: resolved.identity, skillVersion: ANYSEARCH_VERSION, skillCommit: ANYSEARCH_COMMIT, workflowVersion: COLLECTION_WORKFLOW_VERSION,
      createdAt: now(), state: "ready", counts: { model: 0, search: 0, extract: 0, capabilities: 0, tools: 0 },
      sources: [], candidates: [], operations: [], transcript: [] };
    this.save(session);
    return structuredClone(session);
  }
  budget(id: string) {
    const path = join(this.directory(id), "model-budget.json");
    return existsSync(path) ? readBudget(path) : null;
  }
  cancel(id: string): void {
    const active = this.active.get(id);
    if (active) { active.controller.abort(); active.agent?.abort(); }
  }

  async respond(id: string, input: string, registry: Registry, authorization: { authorisePaid: true }): Promise<CollectionSession> {
    if (authorization?.authorisePaid !== true) throw new Error("搜题模型请求需要明确的费用授权。");
    z.string().trim().min(1).max(20000).parse(input); assertNoCredentials(input, "collection user input");
    if (this.active.has(id)) throw new Error("该搜题会话正在运行，不能重复发送。");
    const session = this.get(id);
    if (session.workflowVersion !== COLLECTION_WORKFLOW_VERSION) throw new Error("旧版搜题会话可查看和生成草稿；请新建会话使用当前搜题流程。");
    if (!["ready", "stopped"].includes(session.state)) throw new Error("该会话已暂停、失败或结果未知；请阅读记录，不能自动续发。");
    const resolved = this.model(session.config, registry);
    if (resolved.identity !== session.modelIdentity || session.skillCommit !== ANYSEARCH_COMMIT) throw new Error("搜题模型或 skill 配置已变化，请新建会话。");
    const active: Active = { controller: new AbortController() };
    this.active.set(id, active);
    try {
      return await withExecutionLease(async () => {
        const dir = this.directory(id), limits = session.config.limits;
        const budgetPath = join(dir, "model-budget.json");
        const budget = new BatchTokenBudget(budgetPath, limits.maxTotalTokens, existsSync(budgetPath));
        if (budget.snapshot().blocked) throw new Error("搜题模型用量未知或预算不可用，未发送新请求。");
        const client = this.clientFactory(session.config);
        const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(limits.turnTimeoutMs)]);
        const tools = this.tools(session, client, signal);
        const previousCount = session.counts.model;
        let denied = false;
        let haltReason: string | undefined;
        const base = makeExamStreamFn(registry.models, { timeoutMs: limits.requestTimeoutMs, maxTokens: limits.maxOutputTokens });
        const raw: StreamFn = (model, context, options) => {
          if (signal.aborted) throw new Error("搜题已取消，未发送新请求。");
          if (session.counts.model >= limits.maxModelRequests) { denied = true; throw new Error("达到搜题模型请求次数上限。"); }
          session.counts.model++; this.save(session);
          active.activity = "等待模型响应";
          const apiKey = this.modelApiKey?.();
          return base(model, context, { ...options, signal, maxRetries: 0, ...(apiKey ? { apiKey } : {}) });
        };
        const budgeted = budget.wrap(raw, { runId: id, trialId: id, questionId: "collection" }, () => { denied = true; haltReason = "Token 预算不足或已有请求用量未知，停止发送。"; });
        const history = session.metrics;
        const metrics = new RequestMetricsCollector(() => {
          const current = metrics.snapshot();
          session.metrics = { ...current, elapsedMs: (history?.elapsedMs ?? 0) + current.elapsedMs,
            requests: [...(history?.requests ?? []), ...current.requests.map((request) => ({ ...request, id: `round-${(history?.requests.length ?? 0) + 1}-${request.id}` }))] };
          this.save(session);
        });
        metrics.setThinkingLevel(session.config.thinkingLevel);
        const stream = metrics.wrap(budgeted);
        const agent = new Agent({
          initialState: { systemPrompt: ANYSEARCH_SKILL + `\nUser collection goal: ${session.goal}\nTarget question count: ${session.config.targetCount ?? "not specified; follow the user's request"}\nCurrent collection progress: ${JSON.stringify(collectionProgress(session))}`, tools, model: resolved.model,
            thinkingLevel: session.config.thinkingLevel, ...(session.transcript.length ? { messages: structuredClone(session.transcript) as Message[] } : {}) },
          streamFn: (model, context, options) => stream(model, context, { ...options, signal, maxTokens: Math.min(limits.maxOutputTokens, model.maxTokens) }),
          onPayload: (payload) => capOutputPayload(payload, Math.min(limits.maxOutputTokens, resolved.model.maxTokens)),
          toolExecution: "sequential",
          transformContext: async (messages) => messages,
          prepareRequest: (request) => {
            if (signal.aborted) throw new Error("搜题已取消或超时。");
            if (session.counts.model >= limits.maxModelRequests) { denied = true; haltReason = "达到搜题模型请求次数上限。"; throw new Error(haltReason); }
            if (contextBudget(request.model, request.context.messages as Message[], limits.maxOutputTokens).remainingTokens < 0) { denied = true; haltReason = "搜题上下文容量不足，来源材料保留，未丢弃原文后继续请求。"; throw new Error(haltReason); }
          },
          beforeToolCall: async (context) => {
            if (signal.aborted || session.counts.tools >= limits.maxToolCalls) { denied = true; haltReason = "搜题已停止或达到工具次数上限。"; return { block: true, reason: haltReason, terminate: true }; }
            active.activity = `工具：${context.toolCall.name}`;
            session.counts.tools++; this.save(session); return undefined;
          },
        });
        active.agent = agent;
        const unsubscribe = agent.subscribe((event) => {
          if (event.type === "message_update" && event.message.role === "assistant") {
            const text = event.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
            try { assertNoCredentials(text, "collection preview"); if (this.modelApiKey?.() && text.includes(this.modelApiKey()!)) throw new Error("敏感内容"); active.text = text; }
            catch { active.text = "返回内容含疑似敏感数据，已隐藏。"; }
            active.activity = "模型正在响应"; this.notify();
          }
        });
        const abort = () => agent.abort(); signal.addEventListener("abort", abort, { once: true });
        session.state = "running"; delete session.error; this.save(session);
        try {
          if (signal.aborted) throw new Error("搜题已取消。");
          await agent.prompt(input);
          await agent.waitForIdle();
          // 不保存推理正文；保留独立搜题对话、工具调用及来源，不传给答题 Agent。
          const transcript = agent.state.messages.map((message) => message.role === "assistant" ?
            { ...message, errorMessage: undefined, content: message.content.filter((block) => block.type !== "thinking") } : message);
          assertNoCredentials(transcript, "collection transcript");
          if (this.modelApiKey?.() && JSON.stringify(transcript).includes(this.modelApiKey()!)) throw new Error("模型回复含当前密钥，拒绝存档。");
          session.transcript = transcript;
          const last = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
          if (active.controller.signal.aborted) session.state = "stopped";
          else if (budget.snapshot().unknownRequests > 0) { session.state = "outcome_unknown"; session.error = "搜题模型用量未知，停止后续派发。"; }
          else if (denied || signal.aborted || last?.stopReason === "length") { session.state = "paused"; session.error = haltReason ?? "搜题达到时间或输出上限，保留材料，请检查后重新安排。"; }
          else if (last?.stopReason !== "stop") { session.state = session.counts.model > previousCount ? "outcome_unknown" : "error"; session.error = "搜题未正常完成，原始材料保留，不自动重发。"; }
          else session.state = "ready";
        } catch {
          session.state = active.controller.signal.aborted ? "stopped" : budget.snapshot().unknownRequests > 0 ? "outcome_unknown" : denied || signal.aborted ? "paused" : session.counts.model > previousCount ? "outcome_unknown" : "error";
          session.error = haltReason ?? "搜题已停止或请求失败；材料保留，没有自动重试。请检查预算和来源记录。";
        } finally { unsubscribe(); signal.removeEventListener("abort", abort); this.save(session); }
        return structuredClone(session);
      });
    } finally { this.active.delete(id); this.notify(); }
  }

  async checkModel(config: CollectionConfig, registry: Registry, authorization: { authorisePaid: true }, signal?: AbortSignal) {
    if (authorization?.authorisePaid !== true) throw new Error("模型连接验证需要单独确认费用。");
    const { model } = this.model(config, registry);
    return withExecutionLease(async () => {
      const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.min(config.limits.turnTimeoutMs, 30000))]);
      const metrics = new RequestMetricsCollector();
      const stream = metrics.wrap(makeExamStreamFn(registry.models, { timeoutMs: Math.min(config.limits.requestTimeoutMs, 30000), maxTokens: 128 }));
      const agent = new Agent({ initialState: { model, tools: [], systemPrompt: "Connectivity check. Reply only OK.", thinkingLevel: "off" },
        streamFn: (model, context, options) => stream(model, context, { ...options, signal: combined, maxTokens: Math.min(model.maxTokens, 128), ...(this.modelApiKey?.() ? { apiKey: this.modelApiKey() } : {}) }),
        onPayload: (payload) => capOutputPayload(payload, Math.min(model.maxTokens, 128)), finishTurn: () => ({ action: "end" }) });
      await agent.prompt("Reply OK to confirm this connection.");
      const last = agent.state.messages.at(-1);
      return { ok: last?.role === "assistant" && last.stopReason === "stop" && last.content.some((part) => part.type === "text" && part.text.trim()), metrics: metrics.snapshot() };
    });
  }

  private async operation(session: CollectionSession, kind: "search" | "extract" | "capabilities", args: unknown, execute: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    const key = sha256OfJsonable({ kind, args });
    const cached = session.operations.find((operation) => operation.key === key);
    if (cached?.state === "completed") return structuredClone(cached.result);
    if (cached) throw new Error("该搜索操作结果未知，不自动再次发送。");
    if (signal.aborted) throw new Error("搜题已取消。");
    const max = kind === "search" ? session.config.limits.maxSearchRequests : kind === "extract" ? session.config.limits.maxExtractRequests : session.config.limits.maxCapabilityRequests;
    if (session.counts[kind] >= max) throw new Error(`达到 ${kind} 请求次数上限。`);
    const record: CollectionSession["operations"][number] = { key, kind, state: "started" };
    session.counts[kind]++; session.operations.push(record); this.save(session);
    try {
      const result = await execute();
      assertNoCredentials(result, "collection search result");
      record.result = result; record.state = "completed"; this.save(session); return structuredClone(result);
    } catch {
      record.state = "unknown"; this.save(session);
      throw new Error(`搜题 ${kind} 未取得可用结果；不自动重试，请检查来源、配额或网络。`);
    }
  }

  private tools(session: CollectionSession, client: AnySearchClient, signal: AbortSignal): AgentTool[] {
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify({ untrustedExternalData: true, value }) }], details: {} });
    const search = async (raw: unknown) => {
      const query = SearchQuerySchema.parse(raw);
      if (query.tag) {
        const capabilities = session.operations.filter((op) => op.kind === "capabilities" && op.state === "completed").flatMap((op) => op.result as SearchDomains);
        const capability = capabilities.flatMap((domain) => domain.sub_domains).find((item) => item.sub_domain === query.tag);
        if (!capability || Object.entries(capability.params).some(([key, info]) => info.required && !Object.hasOwn(query.params ?? {}, key))) throw new Error("垂直搜索需要先发现领域，并提供全部必填参数。");
      }
      return this.operation(session, "search", query, () => client.search(query, signal), signal);
    };
    return [
      { name: "get_sub_domains", label: "发现搜索领域", description: "Discover compact vertical tags and required params. Supply tag for full parameter details from the same cache.", parameters: Type.Object({ domains: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }), tag: Type.Optional(Type.String()) }),
        execute: async (_id, args) => {
          const { domains, tag } = args as { domains: string[]; tag?: string };
          const discovered = await this.operation(session, "capabilities", domains, () => client.getSubDomains(domains, signal), signal) as SearchDomains;
          return result(collectionDomains(discovered, tag));
        } },
      { name: "search", label: "搜索题目来源", description: "Find source links. Snippets are not verified question evidence.", parameters: queryArgs,
        execute: async (_id, args) => result(await search(args)) },
      { name: "batch_search", label: "批量搜索", description: "Run 1-5 independent queries; quota is per query and errors are reported separately.", parameters: Type.Object({ queries: Type.Array(queryArgs, { minItems: 1, maxItems: 5 }) }),
        execute: async (_id, args) => result(await Promise.all((args as { queries: SearchQuery[] }).queries.map(async (query) => {
          try { return { query: query.query, results: await search(query) }; } catch (error) { return { query: query.query, error: (error as Error).message }; }
        }))) },
      { name: "extract", label: "读取来源正文", description: "Extract a public HTTPS textual source; binary documents are unsupported. Returns immutable sourceId and completeness status.", parameters: Type.Object({ url: Type.String() }),
        execute: async (_id, args) => {
          const url = (args as { url: string }).url;
          const page = await this.operation(session, "extract", url, async () => {
            const page = await client.extract(url, signal);
            if (Buffer.byteLength(page.content) + session.sources.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0) > session.config.limits.maxSourceBytes) throw new Error("搜题来源材料达到大小上限。");
            const source = { ...page, id: `source-${sha256OfJsonable(page).slice(0, 24)}`, digest: sha256OfText(page.content), fetchedAt: now() };
            session.sources.push(source); return source;
          }, signal);
          return result(page);
        } },
      { name: "source_links", label: "查看来源链接", description: "Inspect links in an already extracted directory/index using its sourceId. Local navigation only; linked pages still require extract before they become question evidence.",
        parameters: Type.Object({ sourceId: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), contains: Type.Optional(Type.String()) }),
        execute: async (_id, args) => {
          const { sourceId, limit, contains } = args as { sourceId: string; limit?: number; contains?: string };
          const source = session.sources.find((item) => item.id === sourceId);
          if (!source) throw new Error("来源尚未提取或 sourceId 不存在。");
          return result(collectionSourceLinks(source, limit, contains));
        } },
      { name: "propose_question", label: "提出候选题", description: "Propose an existing question with exact extracted-source evidence using {candidate:{question,sourceId,evidence,...}}. Never publishes or starts answering.", parameters: collectionCandidateArgs,
        execute: async (_id, args) => result(await this.propose(session, (args as { candidate: CollectionCandidateInput }).candidate)) },
    ];
  }

  private async propose(session: CollectionSession, raw: CollectionCandidateInput) {
    assertNoCredentials(raw, "collection candidate");
    const candidate = CollectionCandidateSchema.parse(raw);
    const source = session.sources.find((item) => item.id === candidate.sourceId);
    if (!source || source.truncated) throw new Error("候选题必须来自已提取且完整的来源正文。");
    if (!source.content.includes(candidate.question.stem) || !candidate.evidence.some((item) => item.sourceId === source.id)) throw new Error("主要来源必须包含完整题干及对应证据。");
    const quotes = (evidence: typeof candidate.evidence) => evidence.map((item) => {
      const source = session.sources.find((source) => source.id === item.sourceId);
      if (!source || source.truncated || !source.content.includes(item.quote)) throw new Error("来源证据不存在、不完整或不是原文引用。");
      return item.quote;
    });
    const evidence = quotes(candidate.evidence);
    for (const text of [candidate.question.stem, ...Object.values(candidate.question.options ?? {}), ...(candidate.question.parts ?? []).map((part) => part.prompt)]) {
      if (!text.trim() || !evidence.some((quote) => quote.includes(text))) throw new Error("题干、选项或小问未被原文证据完整覆盖。");
      if (mixedScoringContent(text)) throw new Error("公开题面疑似混入答案或解析，请分离后再提交候选题。");
    }
    buildUserContent(candidate.question);
    if (candidate.question.assets.length) throw new Error("当前搜题服务只接收完整文本题；含图题需后续原图处理与核对。");
    if (candidate.scoring) {
      assertScoring(candidate.scoring, candidate.question);
      if (candidate.scoring.deterministicLocked) throw new Error("模型不能将候选评分自动标为已确认。");
      const answerQuotes = quotes(candidate.answerEvidence);
      const refs = typeof candidate.scoring.reference === "string" ? [candidate.scoring.reference] : Object.values(candidate.scoring.reference ?? {});
      if (!answerQuotes.length || !refs.length || refs.some((ref) => !answerQuotes.some((quote) => quote.includes(ref)))) throw new Error("参考答案必须有独立的完整来源证据。");
      if (!answerQuotes.some((quote) => quote.includes(String(candidate.scoring!.maxScore)))) throw new Error("原始满分缺少来源证据；请保留为未评分题目。");
    }
    const hash = fingerprint(candidate.question);
    const existing = session.candidates.find((item) => item.fingerprint === hash || item.question.id === candidate.question.id ||
      (candidate.originalId && item.originalId === candidate.originalId && item.sourceId === candidate.sourceId));
    if (existing) return { accepted: false, duplicateOf: existing.question.id };
    if (session.candidates.length >= session.config.limits.maxCandidates) throw new Error("候选题已达到数量上限。");
    const issues: string[] = [];
    const bank = new ImportService(this.datasetsRoot, this.importRoot).listBank();
    for (const dataset of bank) {
      const root = resolveWithin(this.datasetsRoot, dataset.datasetId);
      const imported = await importDataset({ datasetId: dataset.datasetId, publicDir: join(root, "public"), scoringDir: join(root, "scoring") });
      if (!imported.ok) throw new Error("现有题库未通过校验，无法可靠去重，请先检查题库。");
      for (const item of imported.entries) if (item.question && fingerprint(item.question) === hash) issues.push(`与现有题库重复：${dataset.datasetId}/${item.questionId}`);
    }
    session.candidates.push({ ...candidate, fingerprint: hash, issues }); this.save(session);
    return { accepted: true, questionId: candidate.question.id, issues, scoringStatus: candidate.scoring ? "unverified" : "unscored", progress: collectionProgress(session) };
  }

  stage(id: string, questionIds: string[], expectedDigest: string, scoringApproval?: { by: string; reason: string }): DraftDataset {
    if (this.active.has(id)) throw new Error("搜题仍在运行，请停止或等待完成后生成草稿。");
    const session = this.get(id);
    if (sha256OfJsonable(session) !== expectedDigest) throw new Error("搜题材料已变化，请重新核对后生成草稿。");
    if (!questionIds.length || new Set(questionIds).size !== questionIds.length) throw new Error("请选择不重复的候选题。");
    if (scoringApproval) z.object({ by: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict().parse(scoringApproval);
    const candidates = questionIds.map((id) => {
      const candidate = session.candidates.find((candidate) => candidate.question.id === id);
      if (!candidate || candidate.issues.length) throw new Error("候选题不存在或有未解决的重复问题。");
      return candidate;
    });
    const source = join(this.directory(id), `questions-${randomUUID()}.json`);
    // 原网页正文和答案证据仅进入来源副本，公开请求仍由普通导入器白名单构建。
    const rows = candidates.map((candidate) => ({ ...candidate.question, scoring: scoringApproval ? candidate.scoring : undefined,
      provenance: { collectionId: id, originalId: candidate.originalId, evidence: candidate.evidence, answerEvidence: candidate.answerEvidence,
        authority: "unverified", suggestedScoring: candidate.scoring, scoringApproval,
        scoringStatus: candidate.scoring ? scoringApproval ? "human_reviewed" : "unverified" : "unscored",
        sources: session.sources.filter((source) => source.id === candidate.sourceId || [...candidate.evidence, ...candidate.answerEvidence].some((item) => item.sourceId === source.id)) } }));
    assertNoCredentials(rows, "collection draft source");
    mkdirSync(this.directory(id), { recursive: true }); writeFileSync(source, JSON.stringify(rows, null, 2), { encoding: "utf8", flag: "wx" });
    return new ImportService(this.datasetsRoot, this.importRoot).importSource(source, { datasetId: session.config.datasetId, version: session.config.version });
  }
}
