import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { AnySearchClient } from "../src/providers/anysearch.js";
import { CollectionService } from "../src/service/collection-service.js";
import { collectionCandidateArgs, collectionDomains, collectionProgress, collectionSourceLinks } from "../src/service/collection-workflow.js";
import { COLLECTION_WORKFLOW_VERSION, CollectionConfigSchema, type CollectionSource } from "../src/shared/collection.js";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { sha256OfJsonable, sha256OfText } from "../src/shared/hashing.js";
import { buildUserContent } from "../src/runner/prompt.js";
import { publicQuestion } from "../src/import/validation.js";

const index = { url: "https://example.com/problems", title: "离线多学科题目目录", content: "# 测试目录\n[数学题](/problems/math)\n[化学题][chem]\n[重复数学](/problems/math#top)\n[内网](https://127.0.0.1/a)\n[敏感](https://example.com/a?api_key=hidden)\n\n[chem]: /problems/chem\n", contentType: "text/markdown", truncated: false };
const pages = [{ url: "https://example.com/problems/math", title: "离线数学验证题", content: "Compute 2+2.", contentType: "text/plain", truncated: false },
  { url: "https://example.com/problems/chem", title: "离线化学验证题", content: "State the chemical symbol for oxygen.", contentType: "text/plain", truncated: false }];
const sourceOf = (page: typeof index): CollectionSource => ({ ...page, id: `source-${sha256OfJsonable(page).slice(0, 24)}`, digest: sha256OfText(page.content), fetchedAt: "2026-10-28T00:00:00Z" });
const domains = [{ domain: "academic", sub_domains: [{ sub_domain: "academic.paper", description: "Research papers, not school questions", params: {
  query: { required: true, description: "Paper title" }, optional_filter: { required: false, description: "Long optional explanation ".repeat(300) },
} }] }];
const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args));
const lastTool = (context: { messages: unknown[] }) => {
  const message = context.messages.at(-1) as { content: Array<{ type: string; text?: string }> };
  return JSON.parse(message.content.find((part) => part.type === "text")!.text!).value;
};
const candidate = (i: number) => {
  const page = pages[i]!, source = sourceOf(page);
  return { question: { id: i === 0 ? "math-1" : "chem-1", version: "1", subject: i === 0 ? "math" : "chemistry", answerKind: "open", stem: page.content, assets: [] },
    sourceId: source.id, evidence: [{ sourceId: source.id, quote: page.content, location: "完整题干" }] };
};

function fixture(fetcher?: typeof fetch) {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "collection-workflow-"));
  const model = { id: "collector", name: "Offline collector", contextWindow: 32768, maxTokens: 2048 };
  const faux = fauxProvider({ provider: "workflow-test", models: [model] }), models = createModels(); models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "collector", displayName: "Offline", provider: "workflow-test", api: "faux", baseUrl: "https://offline.example/v1", auth: { envVars: ["OFFLINE_TEST_KEY"] }, models: [model] });
  const registry = { models, profilesById: new Map([[profile.id, profile]]) };
  let calls = 0;
  const service = new CollectionService(join(root, "drafts"), join(root, "datasets"), () => new AnySearchClient({ resolveHost: async () => ["93.184.216.34"], fetch: fetcher ?? (async (url, init) => {
    calls++; const path = new URL(String(url)).pathname;
    if (path === "/v1/sub-domains") return Response.json({ data: { domains } });
    if (path === "/v1/search") return Response.json({ data: { results: [{ title: index.title, url: index.url }] } });
    const target = JSON.parse(String(init?.body)).url, page = [index, ...pages].find((page) => page.url === target);
    if (!page) throw new Error("Unexpected fixture URL");
    return Response.json({ data: { ...page, content_type: page.contentType } });
  }) }));
  const config = CollectionConfigSchema.parse({ datasetId: "offline-mixed", profileId: "collector", modelId: model.id, targetCount: 2, limits: { maxTotalTokens: 150000 } });
  const session = service.create("Collect one math and one chemistry question", config, registry);
  const run = async (steps: FauxResponseStep[]) => { faux.setResponses(steps); return service.respond(session.id, "Start the requested two-subject collection", registry, { authorisePaid: true }); };
  return { root, faux, service, session, registry, config, run, calls: () => calls };
}

describe("面向完整组卷流程", () => {
  it("目录链接由 Markdown AST 提取，保留相对和引用链接，拒绝危险 URL", () => {
    const out = collectionSourceLinks(sourceOf(index));
    expect(out.links).toEqual([{ title: "数学题", url: pages[0]!.url }, { title: "化学题", url: pages[1]!.url }]);
    expect(out.rejected).toBe(2); expect(out.omitted).toBe(0);
    expect(collectionSourceLinks(sourceOf(index), 1).omitted).toBe(1);
    expect(collectionSourceLinks(sourceOf(index), 10, "chem").links).toHaveLength(1);
  });
  it("领域目录精简但完整参数可按标签读取，必填项仍可见", () => {
    const compact = JSON.stringify(collectionDomains(domains));
    expect(compact).toContain("Paper title"); expect(compact).not.toContain("Long optional explanation");
    expect(compact.length).toBeLessThan(JSON.stringify(domains).length / 5);
    expect(collectionDomains(domains, "academic.paper")).toEqual(domains[0]!.sub_domains[0]);
    expect(() => collectionDomains(domains, "invented.tag")).toThrow("不在");
  });
  it("候选工具声明包括完整必填结构，公开题面与评分为不同字段", () => {
    const schema = JSON.parse(JSON.stringify(collectionCandidateArgs));
    expect(schema.required).toEqual(["candidate"]);
    expect(schema.properties.candidate.required).toEqual(["question", "sourceId", "evidence"]);
    expect(schema.properties.candidate.properties.question.required).toEqual(expect.arrayContaining(["id", "version", "subject", "answerKind", "stem", "assets"]));
    expect(schema.properties.candidate.properties.question.properties).not.toHaveProperty("scoring");
    expect(schema.properties.candidate.properties.scoring.properties).toHaveProperty("reference");
  });
  it("多学科真实 Agent/本地 HTTP：搜索目录、追踪详情、忠实转换、核对并保存草稿", async () => {
    const paths: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      paths.push(req.url!); res.setHeader("content-type", "application/json");
      if (req.url!.startsWith("/v1/sub-domains")) res.end(JSON.stringify({ data: { domains } }));
      else if (req.url === "/v1/search") res.end(JSON.stringify({ data: { results: [{ title: index.title, url: index.url }] } }));
      else { const page = [index, ...pages].find((page) => page.url === body.url); if (!page) { res.writeHead(400); res.end("{}"); } else res.end(JSON.stringify({ data: { ...page, content_type: page.contentType } })); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port;
    const s = fixture((url, init) => { const target = new URL(String(url)); return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init); });
    try {
      let details: Array<{ url: string }> = [];
      const done = await s.run([
        tool("get_sub_domains", { domains: ["academic"] }),
        (context) => { expect(JSON.stringify(lastTool(context))).not.toContain("Long optional explanation"); return tool("get_sub_domains", { domains: ["academic"], tag: "academic.paper" }); },
        (context) => { expect(lastTool(context).params.optional_filter.description).toContain("Long optional explanation"); return tool("search", { query: "site:example.com/problems math chemistry questions" }); },
        (context) => tool("extract", { url: lastTool(context)[0].url }),
        (context) => tool("source_links", { sourceId: lastTool(context).id }),
        (context) => { details = lastTool(context).links; expect(details).toHaveLength(2); return tool("extract", { url: details[0]!.url }); },
        (context) => { expect(lastTool(context).content).toBe(pages[0]!.content); return tool("propose_question", { candidate: candidate(0) }); },
        (context) => { expect(lastTool(context).progress).toMatchObject({ accepted: 1, remaining: 1 }); return tool("extract", { url: details[1]!.url }); },
        tool("propose_question", { candidate: candidate(1) }),
        (context) => { expect(lastTool(context).progress.targetReached).toBe(true); return fauxAssistantMessage("两道离线验证题已搜集，等待人工核对。"); },
      ]);
      expect(done.state).toBe("ready"); expect(done.workflowVersion).toBe(COLLECTION_WORKFLOW_VERSION);
      expect(collectionProgress(done)).toMatchObject({ target: 2, accepted: 2, remaining: 0, targetReached: true, readableSources: 3, canStage: true });
      expect(paths.filter((path) => path.startsWith("/v1/sub-domains"))).toHaveLength(1);
      expect(paths.filter((path) => path === "/v1/search")).toHaveLength(1);
      expect(paths.filter((path) => path === "/v1/extract")).toHaveLength(3);
      const draft = s.service.stage(done.id, done.candidates.map((candidate) => candidate.question.id), sha256OfJsonable(done));
      expect(draft.status).toBe("draft"); expect(draft.questions).toHaveLength(2); expect(draft.questions.map((question) => question.subject)).toEqual(["math", "chemistry"]);
      expect(draft.questions.every((question) => question.scoring === undefined)).toBe(true);
      expect(buildUserContent(publicQuestion(draft.questions[0]!))).toContain(pages[0]!.content);
      expect(buildUserContent(publicQuestion(draft.questions[0]!))).not.toContain("测试目录");
      expect(existsSync(join(s.root, "datasets"))).toBe(false);
      expect(new CollectionService(join(s.root, "drafts"), join(s.root, "datasets")).get(done.id).candidates).toHaveLength(2);
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it("来源目录和模型声称已完成均不能充当候选题", async () => {
    const s = fixture(); const done = await s.run([tool("extract", { url: index.url }), fauxAssistantMessage("Collected two questions.")]);
    expect(collectionProgress(done)).toMatchObject({ accepted: 0, remaining: 2, targetReached: false, canStage: false });
    expect(collectionProgress(done).next).toContain("source_links");
    expect(() => s.service.stage(done.id, [], sha256OfJsonable(done))).toThrow("请选择");
  });
  it("目标题数与保护上限分开校验", () => {
    const s = fixture(); expect(() => CollectionConfigSchema.parse({ ...s.config, targetCount: 101 })).toThrow("目标题数");
    expect(() => CollectionConfigSchema.parse({ ...s.config, targetCount: 0 })).toThrow();
  });
  it("旧版会话仍可读取，协议变化后禁止直接续发", async () => {
    const s = fixture(); const path = join(s.root, "drafts", s.session.id, "collection.json");
    const saved = JSON.parse(readFileSync(path, "utf8")); delete saved.workflowVersion; writeFileSync(path, JSON.stringify(saved));
    expect(s.service.get(saved.id).goal).toBe(s.session.goal);
    await expect(s.service.respond(saved.id, "continue", s.registry, { authorisePaid: true })).rejects.toThrow("旧版搜题会话");
    expect(s.faux.state.callCount).toBe(0); expect(s.calls()).toBe(0);
  });
});
