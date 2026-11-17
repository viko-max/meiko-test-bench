import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { CollectionWorkspace } from "../src/tui/collection-controller.js";
import { DeepSeekSearchClient } from "../src/providers/deepseek-search.js";
import { sha256OfJsonable } from "../src/shared/hashing.js";

const url = "https://example.com/questions";
const content = "计算 2+2。\nA. 3\nB. 4\n参考答案：B\n原题分值：5";
const fetched = { url, title: "离线来源", content, truncated: false, contentType: null };
const sourceId = `source-${sha256OfJsonable(fetched).slice(0, 24)}`;
const candidate = { question: { id: "q1", version: "1", subject: "math", answerKind: "single_choice", stem: "计算 2+2。", options: { A: "3", B: "4" }, assets: [] },
  sourceId, evidence: [{ sourceId, quote: "计算 2+2。\nA. 3\nB. 4", location: "第一题" }] };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args));
async function fixture() {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "collection-ds-tui-"));
  const model = { id: "collector", name: "离线搜题模型", input: ["text"] as Array<"text">, contextWindow: 32768, maxTokens: 4096 };
  const profile = ModelProfileSchema.parse({ id: "collect", displayName: "离线接口", provider: "collection-ds-test", api: "faux", baseUrl: "https://offline.example/v1", auth: { envVars: ["OFFLINE_COLLECTION_KEY"] }, models: [model] });
  const faux = fauxProvider({ provider: profile.provider, models: [model] }); const models = createModels(); models.setProvider(faux.provider);
  const registry = { models, profilesById: new Map([[profile.id, profile]]) };
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/tools/search"
      ? { results: [{ title: fetched.title, url, snippet: "摘要" }] }
      : { title: fetched.title, content }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const workspace = new CollectionWorkspace({
    importRoot: join(root, "drafts"), datasetsRoot: join(root, "datasets"),
    registry: () => registry, models: () => [{ profileId: "collect", modelId: "collector", label: "离线接口 / 离线搜题模型", baseUrl: profile.baseUrl }],
    client: (_config, getApiKey) => new DeepSeekSearchClient({ getApiKey, endpoint: base, timeoutMs: 500, fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as typeof globalThis.fetch }),
  });
  const close = async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((e) => e ? reject(e) : done())); };
  return { root, workspace, faux, requests, close };
}

describe("DeepSeek 搜题 TUI 配置", () => {
  it("设置页可切换 AnySearch/DeepSeek；DeepSeek 默认 DEEPSEEK_API_KEY 且禁止匿名；整理模型独立选择", async () => {
    const s = await fixture();
    try {
      expect(s.workspace.config.searchProvider).toBe("anysearch");
      s.workspace.setSearchProvider("deepseek");
      expect(s.workspace.config).toMatchObject({ searchProvider: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" });
      expect(() => s.workspace.setSearchMode("anonymous")).toThrow("禁止匿名");
      expect(s.workspace.message).toContain("相互独立");
      // 整理模型与搜索服务独立：切换 provider 不影响模型选择流程。
      s.workspace.chooseModels(); s.workspace.selectModel(0);
      expect(s.workspace.config).toMatchObject({ profileId: "collect", modelId: "collector", searchProvider: "deepseek" });
      s.workspace.setSecret("model", "OFFLINE_ONLY_MODEL_CREDENTIAL");
      expect(s.workspace.credentials().modelReady).toBe(true);
      s.workspace.setSearchProvider("anysearch");
      expect(s.workspace.config).toMatchObject({ searchProvider: "anysearch", apiKeyEnv: "ANYSEARCH_API_KEY" });
      s.workspace.setSearchMode("anonymous");
      expect(s.workspace.config.apiKeyEnv).toBeUndefined();
    } finally { await s.close(); }
  });
  it("搜索连接确认按 provider 发送 1 次 count=1 search，并提示按次计费", async () => {
    const s = await fixture();
    try {
      s.workspace.setSearchProvider("deepseek"); s.workspace.setSecret("search", "OFFLINE_ONLY_SEARCH_CREDENTIAL");
      s.workspace.prepare("searchProbe");
      const details = s.workspace.confirmationDetails().join("\n");
      expect(details).toContain("DeepSeek"); expect(details).toContain("count=1"); expect(details).toContain("0.005");
      expect(s.requests).toHaveLength(0);
      await s.workspace.confirm();
      expect(s.workspace.searchVerified).toBe(true);
      expect(s.requests).toEqual([{ path: "/v1/tools/search", body: { query: "connection check", count: 1, need_content: false } }]);
      expect(s.workspace.message).toContain("按次计费");
    } finally { await s.close(); }
  });
  it("发送摘要显示 search/fetch 上限与费用估算预算；设置保存只存环境变量名", async () => {
    const s = await fixture();
    try {
      s.workspace.setSearchProvider("deepseek"); s.workspace.setSecret("search", "k");
      s.workspace.chooseModels(); s.workspace.selectModel(0);
      s.workspace.setSecret("model", "m");
      s.workspace.setField("maxSearchSpendYuan", "0.02");
      expect(s.workspace.config.limits.maxSearchSpendYuan).toBe(0.02);
      s.workspace.prepare("send", "寻找一道数学题");
      const details = s.workspace.confirmationDetails().join("\n");
      expect(details).toContain("抓取上限"); expect(details).toContain("费用估算上限 0.02 元");
      s.workspace.back();
      s.workspace.savePreferences();
      const saved = JSON.parse(readFileSync(join(s.root, "drafts", "collection-settings.json"), "utf8")) as { searchProvider: string; apiKeyEnv: string };
      expect(saved).toMatchObject({ searchProvider: "deepseek", apiKeyEnv: "MEIKO_SESSION_ANYSEARCH_KEY" });
      s.workspace.stop();
      expect(s.workspace.message).toContain("等待存档");
    } finally { await s.close(); }
  });
  it("正常入口切换 DeepSeek 后完成 search → fetch → propose 并生成草稿", async () => {
    const s = await fixture();
    try {
      s.workspace.setSearchProvider("deepseek"); s.workspace.setSecret("search", "k");
      s.workspace.chooseModels(); s.workspace.selectModel(0);
      s.workspace.setSecret("model", "m");
      s.faux.setResponses([call("search", { query: "数学题 原始来源" }), call("fetch", { url }), call("propose_question", { candidate }), fauxAssistantMessage("已找到一题")]);
      s.workspace.input = "寻找一道有原始来源的数学题"; s.workspace.prepare("send");
      await s.workspace.confirm();
      await vi.waitFor(() => expect(s.workspace.busy).toBe(false));
      const session = s.workspace.session!;
      expect(session.candidates).toHaveLength(1);
      expect(session.counts).toMatchObject({ search: 1, fetch: 1 });
      expect(session.deepseekUsage?.search.estimatedYuan).toBe(0.005);
      expect(session.deepseekUsage?.fetch.billableRequests).toBe(1);
      expect(requestsOf(s.requests)).toEqual(["/v1/tools/search", "/v1/tools/fetch"]);
      s.workspace.candidates(); s.workspace.toggleCandidate(); s.workspace.prepare("stage");
      await s.workspace.confirm();
      expect(s.workspace.draft?.questions).toHaveLength(1);
      expect(s.workspace.page).toBe("publish");
    } finally { await s.close(); }
  });
});
const requestsOf = (requests: Array<{ path: string }>) => requests.map((entry) => entry.path);
