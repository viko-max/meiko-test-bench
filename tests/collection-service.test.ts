import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type SimpleStreamOptions, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { CollectionService } from "../src/service/collection-service.js";
import { AnySearchClient } from "../src/providers/anysearch.js";
import { CollectionConfigSchema, type CollectionCandidateInput } from "../src/shared/collection.js";
import { sha256OfJsonable } from "../src/shared/hashing.js";
import { ImportService } from "../src/import/import-service.js";
import { buildUserContent } from "../src/runner/prompt.js";
import { acquireExecutionLease } from "../src/runner/execution-lock.js";
import { publicQuestion } from "../src/import/validation.js";

const url = "https://example.com/questions";
const body = "Compute 2+2.\nA. 3\nB. 4\nAnswer: B\nMax score: 5\n";
const page = { url, title: "Offline protocol fixture", content: body, truncated: false, contentType: "text/plain" };
const sourceId = `source-${sha256OfJsonable(page).slice(0, 24)}`;
const candidate = (): CollectionCandidateInput => ({
  question: { id: "q1", version: "1", subject: "math", answerKind: "single_choice", stem: "Compute 2+2.", options: { A: "3", B: "4" }, assets: [] },
  sourceId, originalId: "original-1", evidence: [{ sourceId, quote: "Compute 2+2.\nA. 3\nB. 4", location: "question 1" }],
  answerEvidence: [{ sourceId, quote: "Answer: B\nMax score: 5", location: "answer table" }],
  scoring: { questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: false },
});
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args));
function fixture(overrides: Record<string, number> = {}, fetchOverride?: typeof fetch) {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "collection-service-"));
  const faux = fauxProvider({ provider: "collect-test", models: [{ id: "collector", contextWindow: 32768, maxTokens: 4096 }] });
  const models = createModels(); models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "collect", provider: "collect-test", displayName: "Offline collector", api: "faux", baseUrl: "https://offline.example/v1", auth: { envVars: ["OFFLINE_COLLECTION_KEY"] }, models: [{ id: "collector", name: "Collector", contextWindow: 32768, maxTokens: 4096 }] });
  const registry = { models, profilesById: new Map([[profile.id, profile]]) };
  const requests: string[] = [];
  const service = new CollectionService(join(root, "drafts"), join(root, "datasets"), () => new AnySearchClient({
    timeoutMs: 500, resolveHost: async () => ["93.184.216.34"], fetch: async (input, init) => {
      const path = new URL(String(input)).pathname; requests.push(path);
      if (fetchOverride) return fetchOverride(input, init);
      return Response.json({ code: 0, data: path === "/v1/search" ? { results: [{ title: page.title, url, snippet: "snippet cannot be evidence" }] } : path === "/v1/sub-domains" ? { domains: [{ domain: "academic", sub_domains: [{ sub_domain: "academic.search", params: { area: { required: true } } }] }] } : { ...page, content_type: page.contentType } });
    },
  }));
  const config = CollectionConfigSchema.parse({ datasetId: "collected", profileId: "collect", modelId: "collector", limits: { maxTotalTokens: 150000, maxOutputTokens: 512, turnTimeoutMs: 5000, requestTimeoutMs: 500, ...overrides } });
  const session = service.create("Find existing math problems with sources", config, registry);
  const run = (steps: FauxResponseStep[], input = "Start collection") => { faux.setResponses(steps); return service.respond(session.id, input, registry, { authorisePaid: true }); };
  return { root, faux, registry, config, session, service, requests, run };
}

describe("独立对话搜题服务", () => {
  it("真实 Pi loop 搜索、提取、提出候选并生成普通草稿；答案、来源及搜题聊天不进入公开输入", async () => {
    const s = fixture(); let sent: SimpleStreamOptions | undefined; let tools: string[] = [];
    expect(s.faux.state.callCount).toBe(0); expect(existsSync(join(s.root, "datasets"))).toBe(false);
    const done = await s.run([
      (context, options) => { sent = options; tools = (context.messages[0] as { toolsAdded?: Array<{ name: string }> }).toolsAdded?.map((tool) => tool.name) ?? []; return call("search", { query: "official math" }); },
      call("extract", { url }), call("propose_question", { candidate: candidate() }), fauxAssistantMessage("One question found; review before publication."),
    ]);
    expect(done.state).toBe("ready"); expect(done.candidates).toHaveLength(1); expect(done.sources[0]).toMatchObject({ id: sourceId, content: body, truncated: false });
    expect(done.counts).toMatchObject({ model: 4, search: 1, extract: 1, tools: 3 });
    expect(sent?.maxRetries).toBe(0); expect(sent?.maxTokens).toBe(512);
    expect(tools).toEqual(["get_sub_domains", "search", "batch_search", "extract", "source_links", "propose_question"]);
    const draft = s.service.stage(done.id, ["q1"], sha256OfJsonable(done));
    expect(draft.questions[0]?.scoring).toBeUndefined();
    const publicText = buildUserContent(publicQuestion(draft.questions[0]!));
    expect(publicText).toContain("Compute 2+2."); expect(publicText).not.toContain("Answer: B"); expect(publicText).not.toContain("Max score"); expect(publicText).not.toContain("api.anysearch");
    const source = JSON.parse(readFileSync(draft.source, "utf8")); expect(source[0].provenance.sources[0].content).toBe(body); expect(source[0].provenance.scoringStatus).toBe("unverified");
    const reviewed = s.service.stage(done.id, ["q1"], sha256OfJsonable(done), { by: "human", reason: "checked original question and marking table" });
    expect(reviewed.questions[0]?.scoring?.reference).toBe("B");
    const imported = await new ImportService(join(s.root, "datasets"), join(s.root, "drafts")).confirmDraft(reviewed.draftId);
    expect(readFileSync(join(imported.path, "public", "q1.md"), "utf8")).not.toContain("Answer: B");
    expect(s.service.budget(done.id)?.unknownRequests).toBe(0);
    expect(new CollectionService(join(s.root, "drafts"), join(s.root, "datasets")).get(done.id).candidates).toHaveLength(1);
  });
  it("重复请求命中会话缓存；继续对话保留材料及预算；重复候选不增加题数", async () => {
    const s = fixture(); const first = await s.run([call("extract", { url }), call("propose_question", { candidate: candidate() }), fauxAssistantMessage("done")]);
    const second = await s.run([call("extract", { url }), call("propose_question", { candidate: candidate() }), fauxAssistantMessage("already included")], "Keep the same question");
    expect(first.candidates).toHaveLength(1); expect(second.candidates).toHaveLength(1); expect(second.counts.extract).toBe(1); expect(s.requests).toEqual(["/v1/extract"]);
    expect(s.service.budget(second.id)?.entries).toHaveLength(6);
    expect(() => s.service.stage(second.id, ["q1"], sha256OfJsonable(first))).toThrow("已变化");
    expect(s.service.list()).toHaveLength(1);
  });
  it("无授权、错误模型身份及其他执行中的任务都在请求前拒绝", async () => {
    const s = fixture();
    await expect(s.service.respond(s.session.id, "start", s.registry, { authorisePaid: false } as never)).rejects.toThrow("授权");
    const profile = s.registry.profilesById.get("collect")!; s.registry.profilesById.set("collect", { ...profile, baseUrl: "https://changed.example/v1" });
    await expect(s.service.respond(s.session.id, "start", s.registry, { authorisePaid: true })).rejects.toThrow("已变化"); s.registry.profilesById.set("collect", profile);
    const lease = await acquireExecutionLease();
    try { await expect(s.run([fauxAssistantMessage("never")])).rejects.toThrow("project lock"); } finally { await lease.release(); }
    expect(s.faux.state.callCount).toBe(0);
  });
  it("Token 与模型次数上限在发送前停止，无自动重试", async () => {
    const s = fixture({ maxTotalTokens: 1 }); const out = await s.run([fauxAssistantMessage("never")]); expect(out.state).toBe("paused"); expect(s.faux.state.callCount).toBe(0);
    const one = fixture({ maxModelRequests: 1 }); const limited = await one.run([call("search", { query: "math" }), fauxAssistantMessage("must not send")]);
    expect(limited.state).toBe("paused"); expect(one.faux.state.callCount).toBe(1); expect(limited.counts.search).toBe(1);
  });
  it("逐项计数的批量搜索允许部分成功，超限条目未发送", async () => {
    const s = fixture({ maxSearchRequests: 1 });
    const out = await s.run([call("batch_search", { queries: [{ query: "first" }, { query: "second" }] }), fauxAssistantMessage("Only one search was available.")]);
    expect(out.counts.search).toBe(1); expect(s.requests).toEqual(["/v1/search"]); expect(JSON.stringify(out.transcript)).toContain("请求次数上限");
  });
  it("垂直搜索必须先发现领域和全部必填参数，缓存领域发现", async () => {
    const s = fixture();
    const out = await s.run([call("search", { query: "math", tag: "academic.search" }), call("get_sub_domains", { domains: ["academic"] }),
      call("get_sub_domains", { domains: ["academic"] }), call("search", { query: "math", tag: "academic.search" }),
      call("search", { query: "math", tag: "academic.search", params: { area: "" } }), fauxAssistantMessage("done")]);
    expect(out.counts.capabilities).toBe(1); expect(out.counts.search).toBe(1); expect(JSON.stringify(out.transcript)).toContain("全部必填参数");
  });
  it.each(["invented", "missing-evidence", "locked", "missing-score-source"]) ("拒绝没有充分来源的候选 %s", async (kind) => {
    const s = fixture(), value = candidate();
    if (kind === "invented") value.question.stem = "Invented conditions";
    if (kind === "missing-evidence") value.evidence[0]!.quote = "not in source";
    if (kind === "locked") value.scoring!.deterministicLocked = true;
    if (kind === "missing-score-source") value.scoring!.maxScore = 7;
    const out = await s.run([call("extract", { url }), call("propose_question", { candidate: value }), fauxAssistantMessage("Needs review")]);
    expect(out.candidates).toHaveLength(0);
  });
  it("截断材料不能作为候选证据", async () => {
    const s = fixture({}, async () => Response.json({ data: { ...page, content_type: "text/plain", truncated: true } }));
    const out = await s.run([call("extract", { url }), call("propose_question", { candidate: candidate() }), fauxAssistantMessage("incomplete source")]);
    expect(out.sources[0]?.truncated).toBe(true); expect(out.candidates).toHaveLength(0);
  });
  it("取消正在提取的来源会终止等待，保存未知操作且不重发", async () => {
    let entered = false;
    const s = fixture({}, async (_url, options) => { entered = true; return new Promise((_done, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); });
    const pending = s.run([call("extract", { url }), fauxAssistantMessage("must stop")]);
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(s.service.respond(s.session.id, "duplicate", s.registry, { authorisePaid: true })).rejects.toThrow("正在运行");
    s.service.cancel(s.session.id); const out = await pending;
    expect(out.state).toBe("stopped"); expect(out.operations[0]?.state).toBe("unknown"); expect(s.faux.state.callCount).toBe(1); expect(s.requests).toHaveLength(1);
  });
  it("重启后的未结束会话不自动续发，来源内容变更也拒绝读取", () => {
    const s = fixture(); const file = join(s.root, "drafts", s.session.id, "collection.json");
    writeFileSync(file, JSON.stringify({ ...s.session, state: "running" })); expect(s.service.get(s.session.id).state).toBe("outcome_unknown");
    writeFileSync(file, JSON.stringify({ ...s.session, sources: [{ ...page, id: sourceId, digest: "wrong", fetchedAt: "offline" }] }));
    expect(() => s.service.get(s.session.id)).toThrow("摘要不一致");
  });
  it("未知模型用量停止下一轮，重启后也拒绝再发送", async () => {
    const s = fixture();
    const original = s.registry.models.streamSimple.bind(s.registry.models);
    const spy = vi.spyOn(s.registry.models, "streamSimple").mockImplementation((...args) => {
      const source = original(...args);
      return { [Symbol.asyncIterator]: async function* () { for await (const event of source) {
        if (event.type === "done") event.message.usage = { ...event.message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
        yield event;
      } }, result: () => source.result() } as AssistantMessageEventStream;
    });
    try {
      const out = await s.run([call("search", { query: "math" }), fauxAssistantMessage("must not send")]);
      expect(out.state).toBe("outcome_unknown"); expect(s.faux.state.callCount).toBe(1);
      expect(s.service.budget(out.id)?.unknownRequests).toBe(1);
      const restarted = new CollectionService(join(s.root, "drafts"), join(s.root, "datasets"));
      await expect(restarted.respond(out.id, "continue", s.registry, { authorisePaid: true })).rejects.toThrow("结果未知");
      expect(s.faux.state.callCount).toBe(1);
    } finally { spy.mockRestore(); }
  });
  it("已发布题目会标为重复并阻止再次生成草稿", async () => {
    const s = fixture();
    const first = await s.run([call("extract", { url }), call("propose_question", { candidate: candidate() }), fauxAssistantMessage("done")]);
    const imports = new ImportService(join(s.root, "datasets"), join(s.root, "drafts"));
    await imports.confirmDraft(s.service.stage(first.id, ["q1"], sha256OfJsonable(first)).draftId);
    const second = s.service.create("Find other questions", { ...s.config, datasetId: "other" }, s.registry);
    s.faux.setResponses([call("extract", { url }), call("propose_question", { candidate: candidate() }), fauxAssistantMessage("duplicate source")]);
    const out = await s.service.respond(second.id, "start", s.registry, { authorisePaid: true });
    expect(out.candidates[0]?.issues.join(" ")).toContain("现有题库重复");
    expect(() => s.service.stage(out.id, ["q1"], sha256OfJsonable(out))).toThrow("重复");
  });
  it("来源总大小与工具次数上限阻止继续获取，已有记录保留", async () => {
    const small = fixture({ maxSourceBytes: 1 });
    const out = await small.run([call("extract", { url }), call("extract", { url }), fauxAssistantMessage("source too large")]);
    expect(out.sources).toHaveLength(0); expect(small.requests).toHaveLength(1); expect(out.operations[0]?.state).toBe("unknown");
    const tools = fixture({ maxToolCalls: 1 });
    const stopped = await tools.run([call("search", { query: "first" }), call("search", { query: "second" }), fauxAssistantMessage("must stop")]);
    expect(stopped.state).toBe("paused"); expect(stopped.counts.tools).toBe(1); expect(tools.requests).toHaveLength(1);
  });
});
