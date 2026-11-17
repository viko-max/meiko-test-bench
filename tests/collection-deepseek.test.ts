import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { CollectionService } from "../src/service/collection-service.js";
import { DeepSeekSearchClient } from "../src/providers/deepseek-search.js";
import { COLLECTION_WORKFLOW_VERSION, CollectionConfigSchema, type CollectionCandidateInput } from "../src/shared/collection.js";
import { sha256OfJsonable } from "../src/shared/hashing.js";
import { buildUserContent } from "../src/runner/prompt.js";
import { publicQuestion } from "../src/import/validation.js";

const url = "https://example.com/questions";
const body = "Compute 2+2.\nA. 3\nB. 4\nAnswer: B\nMax score: 5\n";
const candidate = (): CollectionCandidateInput => ({
  question: { id: "q1", version: "1", subject: "math", answerKind: "single_choice", stem: "Compute 2+2.", options: { A: "3", B: "4" }, assets: [] },
  sourceId: "", originalId: "original-1", evidence: [{ sourceId: "", quote: "Compute 2+2.\nA. 3\nB. 4", location: "question 1" }],
  answerEvidence: [{ sourceId: "", quote: "Answer: B\nMax score: 5", location: "answer table" }],
  scoring: { questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: false },
});
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args));
type Mode = "normal" | "empty-results" | "rejected-urls" | "empty-content" | "invalid-json" | "truncated" | "hang";
async function fixture(overrides: Record<string, number> = {}, mode: Mode = "normal") {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "collection-deepseek-"));
  const faux = fauxProvider({ provider: "collect-ds-test", models: [{ id: "collector", contextWindow: 32768, maxTokens: 4096 }] });
  const models = createModels(); models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "collect", provider: "collect-ds-test", displayName: "Offline collector", api: "faux", baseUrl: "https://offline.example/v1", auth: { envVars: ["OFFLINE_COLLECTION_KEY"] }, models: [{ id: "collector", name: "Collector", contextWindow: 32768, maxTokens: 4096 }] });
  const registry = { models, profilesById: new Map([[profile.id, profile]]) };
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString();
    requests.push({ path: req.url!, body: bodyText ? JSON.parse(bodyText) : null });
    if (mode === "hang") return; // 不响应，用于取消/超时
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/tools/search") {
      res.end(JSON.stringify(mode === "empty-results" ? { results: [] } : mode === "rejected-urls" ?
        { results: [{ title: "Internal only", url: "http://internal.example/page", snippet: "snippet" }] } :
        { results: [{ title: "Official page", url, snippet: "snippet only", summary: "summary" }] }));
    } else {
      res.end(JSON.stringify(mode === "empty-content" ? { title: "Empty", content: "" } : mode === "invalid-json" ? "not-json" :
        mode === "truncated" ? { title: "Part", content: body, truncated: true } : { title: "Official page", content: body }));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const service = new CollectionService(join(root, "drafts"), join(root, "datasets"), () => new DeepSeekSearchClient({
    getApiKey: () => "sk-offline-search-key", endpoint: base, timeoutMs: mode === "hang" ? 10000 : 1000,
    fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as typeof globalThis.fetch,
  }));
  const config = CollectionConfigSchema.parse({ datasetId: "collected", profileId: "collect", modelId: "collector", searchProvider: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY",
    limits: { maxTotalTokens: 150000, maxOutputTokens: 512, turnTimeoutMs: 8000, requestTimeoutMs: 500, ...overrides } });
  const session = service.create("Find existing math problems with sources", config, registry);
  const run = (steps: FauxResponseStep[], input = "Start collection") => { faux.setResponses(steps); return service.respond(session.id, input, registry, { authorisePaid: true }); };
  const close = async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((e) => e ? reject(e) : done())); };
  return { root, faux, registry, config, session, service, requests, run, close };
}
/** 用真实 fetch 结果回填 sourceId 后再提出候选（模型第二步才能知道 sourceId）。 */
function proposeWith(sourceId: string) {
  const value = candidate();
  value.sourceId = sourceId; value.evidence[0]!.sourceId = sourceId; value.answerEvidence[0]!.sourceId = sourceId;
  return call("propose_question", { candidate: value });
}

describe("DeepSeek Search/Fetch 搜题服务", () => {
  it("模型自主 search → fetch → propose，stage 生成草稿；工具集无领域发现/批量", async () => {
    const s = await fixture(); let tools: string[] = [];
    try {
      const done = await s.run([
        (context) => { tools = (context.messages[0] as { toolsAdded?: Array<{ name: string }> }).toolsAdded?.map((tool) => tool.name) ?? []; return call("search", { query: "official math problems" }); },
        call("fetch", { url }), proposeWith("source-placeholder"), fauxAssistantMessage("done"),
      ]);
      // propose 在上一步未知 sourceId，先失败后由模型用返回的 sourceId 重试（真实循环中两步完成）。
      expect(done.state === "ready" || done.state === "paused").toBe(true);
      expect(tools).toEqual(["search", "fetch", "source_links", "propose_question"]);
      const sourceId = done.sources[0]?.id ?? "";
      const retry = await s.run([proposeWith(sourceId), fauxAssistantMessage("proposed")], "propose it");
      expect(retry.candidates).toHaveLength(1);
      expect(retry.counts).toMatchObject({ search: 1, fetch: 1 });
      expect(retry.workflowVersion).toBe(COLLECTION_WORKFLOW_VERSION);
      expect(retry.deepseekUsage?.search).toMatchObject({ attempts: 1, successfulWithResults: 1, billableRequests: 1, estimatedYuan: 0.005, priceBasis: "official_list_price_estimate" });
      expect(retry.deepseekUsage?.fetch).toMatchObject({ attempts: 1, successfulWithResults: 1, billableRequests: 1, estimatedYuan: 0.005 });
      const draft = s.service.stage(retry.id, ["q1"], sha256OfJsonable(retry));
      expect(buildUserContent(publicQuestion(draft.questions[0]!))).toContain("Compute 2+2.");
      const archived = JSON.parse(readFileSync(join(s.root, "drafts", retry.id, "collection.json"), "utf8"));
      expect(archived.deepseekUsage.search.estimatedYuan).toBe(0.005);
      expect(JSON.stringify(archived)).not.toContain("sk-offline-search-key");
    } finally { await s.close(); }
  });
  it("搜索摘要不能直接作为候选证据；fetch 返回的 sourceId 才能 propose", async () => {
    const s = await fixture();
    try {
      // 会话内手动写入 search 结果后，模型只凭摘要 propose（伪造 sourceId）必须失败。
      const out = await s.run([call("search", { query: "math" }), proposeWith("source-from-snippet"), fauxAssistantMessage("not enough")]);
      expect(out.candidates).toHaveLength(0);
      expect(out.sources).toHaveLength(0);
      expect(out.counts.search).toBe(1);
      expect(out.deepseekUsage?.search.billableRequests).toBe(1);
    } finally { await s.close(); }
  });
  it("search 原始结果非空但全部被公开 URL 策略拒绝：仍按 provider 结果计费", async () => {
    const s = await fixture({}, "rejected-urls");
    try {
      const out = await s.run([call("search", { query: "math" }), fauxAssistantMessage("all urls rejected")]);
      expect(out.counts.search).toBe(1);
      // 工具返回 results 为空（URL 全部被丢弃），但 DeepSeek 原始 200 results 非空，官方口径已计费。
      expect(out.deepseekUsage?.search).toMatchObject({ attempts: 1, successfulWithResults: 1, billableRequests: 1, estimatedYuan: 0.005, priceBasis: "official_list_price_estimate" });
      expect(out.operations.find((op) => op.kind === "search")?.state).toBe("completed");
    } finally { await s.close(); }
  });
  it("fetch 成功但来源超过大小上限：已发生用量保留，材料不入库、不可 propose", async () => {
    const s = await fixture({ maxSourceBytes: 16 });
    try {
      const out = await s.run([call("fetch", { url }), proposeWith("source-any"), fauxAssistantMessage("rejected")]);
      expect(out.counts.fetch).toBe(1);
      expect(out.sources).toHaveLength(0);
      expect(out.candidates).toHaveLength(0);
      expect(out.operations.find((op) => op.kind === "fetch")?.state).toBe("unknown");
      // provider 200 且正文非空：本地大小校验拒绝来源不撤销已发生计费。
      expect(out.deepseekUsage?.fetch).toMatchObject({ attempts: 1, successfulWithResults: 1, billableRequests: 1, estimatedYuan: 0.005 });
    } finally { await s.close(); }
  });
  it("空搜索结果合法且不计费；attempts 与 billable 分开记录", async () => {
    const s = await fixture({}, "empty-results");
    try {
      const out = await s.run([call("search", { query: "nothing" }), fauxAssistantMessage("no results")]);
      expect(out.state).toBe("ready");
      expect(out.deepseekUsage?.search).toMatchObject({ attempts: 1, successfulWithResults: 0, billableRequests: 0, estimatedYuan: 0 });
    } finally { await s.close(); }
  });
  it("抓取次数与费用估算预算在请求前阻止；空正文/无效响应不计费且不入库", async () => {
    const limited = await fixture({ maxFetchRequests: 1 });
    try {
      const out = await limited.run([call("fetch", { url }), call("fetch", { url: "https://example.com/other" }), fauxAssistantMessage("quota")]);
      expect(out.counts.fetch).toBe(1);
      expect(limited.requests.filter((r) => r.path === "/v1/tools/fetch")).toHaveLength(1);
      expect(JSON.stringify(out.transcript)).toContain("请求次数上限");
      expect(out.deepseekUsage?.fetch.billableRequests).toBe(1);
    } finally { await limited.close(); }
    const costly = await fixture({ maxSearchSpendYuan: 0.005 });
    try {
      const out = await costly.run([call("search", { query: "first" }), call("search", { query: "second" }), fauxAssistantMessage("budget")]);
      expect(out.deepseekUsage?.search.billableRequests).toBe(1);
      expect(costly.requests.filter((r) => r.path === "/v1/tools/search")).toHaveLength(1);
      expect(JSON.stringify(out.transcript)).toContain("费用估算预算上限");
    } finally { await costly.close(); }
    const empty = await fixture({}, "empty-content");
    try {
      const out = await empty.run([call("fetch", { url }), fauxAssistantMessage("empty")]);
      expect(out.sources).toHaveLength(0); expect(out.counts.fetch).toBe(1);
      expect(out.deepseekUsage?.fetch).toMatchObject({ attempts: 1, billableRequests: 0, estimatedYuan: 0 });
      expect(out.operations[0]?.state).toBe("unknown");
    } finally { await empty.close(); }
    const invalid = await fixture({}, "invalid-json");
    try {
      const out = await invalid.run([call("fetch", { url }), fauxAssistantMessage("invalid")]);
      expect(out.sources).toHaveLength(0);
      expect(out.deepseekUsage?.fetch).toMatchObject({ attempts: 1, billableRequests: 0 });
      expect(out.operations[0]?.state).toBe("unknown");
    } finally { await invalid.close(); }
  });
  it("truncated 抓取保留材料但不可作为候选证据", async () => {
    const s = await fixture({}, "truncated");
    try {
      const out = await s.run([call("fetch", { url }), proposeWith("placeholder"), fauxAssistantMessage("incomplete")]);
      expect(out.sources[0]?.truncated).toBe(true);
      const retry = await s.run([proposeWith(out.sources[0]!.id), fauxAssistantMessage("must reject")], "try propose");
      expect(retry.candidates).toHaveLength(0);
      // 200 且正文非空：即使截断，按官方口径服务端已计费。
      expect(retry.deepseekUsage?.fetch.billableRequests).toBe(1);
    } finally { await s.close(); }
  });
  it("取消抓取终止等待：操作标未知、不重发、不计费", async () => {
    const s = await fixture({}, "hang");
    try {
      let entered = false;
      s.faux.setResponses([async () => { entered = true; return call("fetch", { url }); }]);
      const pending = s.service.respond(s.session.id, "start", s.registry, { authorisePaid: true });
      await vi.waitFor(() => expect(entered).toBe(true));
      s.service.cancel(s.session.id);
      const out = await pending;
      expect(out.state).toBe("stopped");
      expect(out.operations[0]?.state).toBe("unknown");
      expect(out.deepseekUsage?.fetch).toMatchObject({ attempts: 1, billableRequests: 0 });
      expect(s.requests).toHaveLength(1);
      // 未知操作不自动重发：继续对话再 fetch 同一 URL 被拒绝。
      s.faux.setResponses([call("fetch", { url }), fauxAssistantMessage("must not refetch")]);
      const next = await s.service.respond(s.session.id, "retry?", s.registry, { authorisePaid: true });
      expect(next.counts.fetch).toBe(1);
      expect(s.requests).toHaveLength(1);
      expect(JSON.stringify(next.transcript)).toContain("不自动再次发送");
    } finally { await s.close(); }
  });
  it("DeepSeek 禁止匿名配置；旧 v2 会话可查看和组卷但不能按新身份续发", async () => {
    const s = await fixture();
    try {
      expect(() => s.service.create("anonymous", { ...s.config, apiKeyEnv: undefined }, s.registry)).toThrow("禁止匿名");
      // 模拟旧版 v2 会话（无 fetch 计数、无 deepseekUsage）。
      const legacy = JSON.parse(readFileSync(join(s.root, "drafts", s.session.id, "collection.json"), "utf8"));
      delete legacy.deepseekUsage; legacy.workflowVersion = "collection-v2";
      legacy.counts = { model: 0, search: 0, extract: 0, capabilities: 0, tools: 0 };
      const legacyId = legacy.id as string;
      writeFileSync(join(s.root, "drafts", legacyId, "collection.json"), JSON.stringify(legacy));
      const read = s.service.get(legacyId);
      expect(read.counts.fetch).toBe(0); expect(read.deepseekUsage).toBeUndefined();
      s.faux.setResponses([call("search", { query: "x" }), fauxAssistantMessage("must not run")]);
      await expect(s.service.respond(legacyId, "continue", s.registry, { authorisePaid: true })).rejects.toThrow("旧版");
      expect(s.faux.state.callCount).toBe(0);
    } finally { await s.close(); }
  });
});
