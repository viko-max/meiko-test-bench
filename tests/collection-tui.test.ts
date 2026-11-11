import { beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { AnySearchClient } from "../src/providers/anysearch.js";
import { sha256OfJsonable } from "../src/shared/hashing.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { prepareMascotImage } from "../src/tui/mascot.js";
import * as json from "../src/shared/json.js";

beforeAll(prepareMascotImage);
const url = "https://example.com/questions";
const page = { url, title: "离线测试来源", content: "计算 2+2。\nA. 3\nB. 4\n参考答案：B\n原题分值：5", contentType: "text/plain", truncated: false };
const sourceId = `source-${sha256OfJsonable(page).slice(0, 24)}`;
const candidate = { question: { id: "q1", version: "1", subject: "math", answerKind: "single_choice", stem: "计算 2+2。", options: { A: "3", B: "4" }, assets: [] },
  sourceId, evidence: [{ sourceId, quote: "计算 2+2。\nA. 3\nB. 4", location: "第一题" }], answerEvidence: [{ sourceId, quote: "参考答案：B\n原题分值：5", location: "答案表" }],
  scoring: { questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: false } };
function fixture() {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "collection-tui-"));
  const model = { id: "collector", name: "离线搜题模型", input: ["text"] as Array<"text">, contextWindow: 32768, maxTokens: 4096 };
  const profile = ModelProfileSchema.parse({ id: "collect", displayName: "离线接口", provider: "collection-test", api: "faux", baseUrl: "https://offline.example/v1", auth: { envVars: ["OFFLINE_COLLECTION_KEY"] }, models: [model] });
  const faux = fauxProvider({ provider: profile.provider, models: [model] }); const models = createModels(); models.setProvider(faux.provider);
  const registry = { models, profilesById: new Map([[profile.id, profile]]) };
  const configPath = join(root, "models.json"); writeFileSync(configPath, JSON.stringify({ version: "1", profiles: [profile] }));
  const requests: string[] = [], keys: string[] = [];
  const cfg = { datasetsRoot: join(root, "datasets"), modelsConfigPath: configPath, runsRoot: join(root, "runs"), workRoot: join(root, "work"), importRoot: join(root, "drafts"), toolsVersion: "v1", pythonInterpreter: "python", registryOverride: registry, animation: false,
    collectionClient: (config: Parameters<NonNullable<import("../src/tui/controller.js").ExamTuiConfig["collectionClient"]>>[0], getApiKey: () => string | undefined) => new AnySearchClient({ apiKeyEnv: config.apiKeyEnv, getApiKey, resolveHost: async () => ["93.184.216.34"], fetch: async (input, init) => {
      requests.push(new URL(String(input)).pathname); keys.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
      return Response.json({ data: requests.at(-1) === "/v1/sub-domains" ? { domains: [] } : requests.at(-1) === "/v1/search" ? { results: [{ title: page.title, url, snippet: "简短摘要" }] } : { ...page, content_type: page.contentType } });
    } }),
  };
  const tui = new ExamTui(cfg), app = new ExamApp(tui); app.rerender = vi.fn(); tui.openCollection();
  const workspace = tui.getCollectionWorkspace(); workspace.chooseModels(); workspace.selectModel(0); workspace.setSearchMode("anonymous"); workspace.setSecret("model", "OFFLINE_ONLY_MODEL_CREDENTIAL"); workspace.page = "chat";
  const answer = () => faux.setResponses([fauxAssistantMessage(fauxToolCall("extract", { url })), fauxAssistantMessage(fauxToolCall("propose_question", { candidate })), fauxAssistantMessage("已找到一道题，请核对原文。")]);
  const render = (width = 80) => app.render(width).map(stripTerminalSequences);
  const click = (label: string, width = 80) => {
    const lines = render(width), y = lines.findIndex((line) => line.includes(label)); if (y < 0) throw new Error(`missing action ${label}: ${lines.join("\n")}`);
    const x = visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(label))) + 1;
    app.handleMouse({ type: "press", button: "left", x, y } as never); app.handleMouse({ type: "click", button: "left", x, y } as never);
  };
  return { root, cfg, tui, app, workspace, faux, registry, requests, keys, answer, render, click };
}
async function collect(s: ReturnType<typeof fixture>) {
  s.answer(); s.workspace.input = "寻找一道数学题，有原始来源和答案。"; s.render(); s.app.handleInput("\r");
  expect(s.workspace.page).toBe("confirm"); expect(s.faux.state.callCount).toBe(0); s.app.handleInput("\r");
  await vi.waitFor(() => expect(s.workspace.session?.candidates).toHaveLength(1)); await vi.waitFor(() => expect(s.workspace.busy).toBe(false));
}
function files(path: string): string[] { if (!existsSync(path)) return []; return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]); }

describe("对话搜题 TUI", () => {
  it("/collect 导航及聊天普通字母不会启动请求或触发全局快捷键，Esc 保留输入", async () => {
    const s = fixture(); await s.tui.gotoHome(); s.app.handleInput("/"); s.app.handleInput("collect"); s.app.handleInput("\r");
    await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("collection")); s.render();
    for (const text of ["q", "h", "r", "中文搜题"]) s.app.handleInput(text);
    expect(s.workspace.input).toBe("qhr中文搜题"); expect(s.faux.state.callCount).toBe(0);
    s.app.handleInput("\x1b"); await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("home"));
    s.tui.openCollection(); expect(s.render().join("\n")).toContain("qhr中文搜题"); s.app.dispose();
  });
  it("隐藏输入的搜索 Key 不进入屏幕、设置或会话存档，重新启动需要重新输入", async () => {
    const s = fixture(), secret = "OFFLINE_ONLY_SEARCH_CREDENTIAL"; s.workspace.page = "settings"; s.click("[搜索 Key]");
    s.app.handleInput(`\x1b[200~${secret}\x1b[201~`);
    expect(s.render().join("\n")).not.toContain(secret); expect(s.render().join("\n")).toContain("•••"); s.app.handleInput("\r");
    expect(s.workspace.credentials()).toMatchObject({ mode: "本次会话", searchReady: true }); s.workspace.savePreferences();
    s.workspace.prepare("searchProbe"); expect(s.requests).toHaveLength(0); await s.workspace.confirm();
    expect(s.keys[0]).toBe(`Bearer ${secret}`); expect(s.workspace.searchVerified).toBe(true);
    for (const file of files(s.cfg.importRoot)) expect(readFileSync(file, "utf8")).not.toContain(secret);
    const fresh = new ExamTui(s.cfg).getCollectionWorkspace(); expect(fresh.credentials().searchReady).toBe(false); s.app.dispose();
  });
  it("发送摘要显示实际接口与预算，取消保留输入；材料或配置变化使确认失效", () => {
    const s = fixture(); s.workspace.input = "数学题"; s.render(); s.app.handleInput("\r");
    const summary = s.render().join("\n"); expect(summary).toContain(s.faux.getModel().baseUrl!); expect(summary).toContain("50000");
    s.app.handleInput("\x1b"); expect(s.workspace.input).toBe("数学题"); expect(s.faux.state.callCount).toBe(0);
    s.workspace.prepare("send"); s.workspace.setField("maxTotalTokens", "60000"); expect(() => s.workspace.confirm()).toThrow("已变化"); expect(s.faux.state.callCount).toBe(0); s.app.dispose();
  });
  it("真实 Agent 完成搜题，实时刷新与用量可见；候选、证据、排除和单独入库流程完整", async () => {
    const s = fixture(); await collect(s);
    expect(s.app.rerender).toHaveBeenCalled(); expect(s.workspace.metrics().requests).toBe(3);
    expect(s.render().join("\n")).toContain("候选 1"); expect(s.render().join("\n")).toContain("TPS");
    s.click("[候选题]"); s.render(); s.app.handleInput(" "); expect(s.workspace.selected).toEqual(["q1"]);
    s.click("[排除/恢复]"); expect(s.workspace.excluded).toEqual(["q1"]); expect(s.workspace.selected).toEqual([]);
    s.click("[排除/恢复]"); s.render(); s.app.handleInput(" "); s.click("[查看]"); expect(s.render().join("\n")).toContain("计算 2+2");
    s.click("[来源]"); expect(s.render().join("\n")).toContain(url); s.app.handleInput("\x1b");
    s.click("[采用评分]"); s.workspace.setField("reviewer", "meiko"); s.workspace.setField("reviewReason", "核对原文与答案表");
    s.click("[生成草稿]"); expect(s.workspace.page).toBe("confirm"); expect(existsSync(s.cfg.datasetsRoot)).toBe(false); s.app.handleInput("\r");
    expect(s.workspace.page).toBe("publish"); expect(s.workspace.draft?.questions[0]?.scoring?.reference).toBe("B");
    s.click("[确认入库]"); expect(existsSync(join(s.cfg.datasetsRoot, "collected"))).toBe(false); s.app.handleInput("\r"); await vi.waitFor(() => expect(s.workspace.publishedId).toBe("collected"));
    expect(readFileSync(join(s.cfg.datasetsRoot, "collected/public/q1.md"), "utf8")).not.toContain("参考答案");
    s.click("[创建测评]"); await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("check")); expect(s.faux.state.callCount).toBe(3); s.app.dispose();
  });
  it("评分建议默认不采用；未填写核对人和依据时不能确认采用", async () => {
    const s = fixture(); await collect(s); s.workspace.candidates(); s.workspace.toggleCandidate();
    s.workspace.includeScoring = true; expect(() => s.workspace.prepare("stage")).toThrow("核对人");
    s.workspace.includeScoring = false; s.workspace.prepare("stage"); await s.workspace.confirm(); expect(s.workspace.draft?.questions[0]?.scoring).toBeUndefined(); s.app.dispose();
  });
  it("不可信的学科及模型名称不会执行终端控制序列", async () => {
    const s = fixture(); await collect(s);
    s.workspace.session!.candidates[0]!.question.subject = "math\x1b]52;c;blocked\x07"; s.workspace.page = "candidates";
    expect(s.app.render(80).join("\n")).not.toContain("\x1b]52");
    s.workspace.newConversation(); s.workspace.chooseModels(); s.workspace.modelChoices[0]!.label = "model\x1b]52;c;blocked\x07";
    expect(s.app.render(80).join("\n")).not.toContain("\x1b]52"); s.app.dispose();
  });
  it("草稿编辑沿用现有核对器，改动后旧发布摘要失效", async () => {
    const s = fixture(); await collect(s); s.workspace.candidates(); s.workspace.toggleCandidate(); s.workspace.prepare("stage"); await s.workspace.confirm();
    s.click("[逐题编辑]"); await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("importPreview"));
    s.app.handleInput("\x1b"); expect(s.tui.getState().screen.kind).toBe("collection"); expect(s.workspace.page).toBe("publish");
    s.workspace.prepare("publish");
    const draft = s.workspace.draft!, importer = s.tui.getImporter(); const review = importer.reviewQuestion(draft.draftId, 0);
    importer.editQuestion(draft.draftId, 0, review.digest, "stem", "人工核对后的题面");
    expect(() => s.workspace.confirm()).toThrow("已变化"); expect(existsSync(join(s.cfg.datasetsRoot, "collected"))).toBe(false); s.app.dispose();
  });
  it("历史读取不会自动请求，开始后的设置被冻结；新会话保留旧材料", async () => {
    const s = fixture(); await collect(s); const id = s.workspace.session!.id;
    expect(() => s.workspace.setField("maxSearchRequests", "99")).toThrow("已固定");
    s.workspace.history(); s.workspace.openHistory(0); expect(s.workspace.session?.id).toBe(id); expect(s.faux.state.callCount).toBe(3);
    s.workspace.newConversation(); expect(s.workspace.service.get(id).candidates).toHaveLength(1); expect(s.workspace.session).toBeUndefined(); s.app.dispose();
  });
  it("Ctrl+C 会取消进行中的模型并等待存档，然后退出；已获取材料保留", async () => {
    const s = fixture(); let entered = false, exited = false;
    s.faux.setResponses([async (_context, options) => { entered = true; await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("offline cancelled")), { once: true })); return fauxAssistantMessage("must not return"); }]);
    s.workspace.input = "慢请求"; s.workspace.prepare("send"); const pending = s.workspace.confirm();
    await vi.waitFor(() => expect(entered).toBe(true)); s.app.setQuitHandler(() => { exited = true; }); s.app.handleInput("\x03");
    await pending; await vi.waitFor(() => expect(exited).toBe(true)); expect(s.workspace.busy).toBe(false); expect(s.workspace.session?.state).toBe("stopped");
    expect(existsSync(join(s.cfg.importRoot, s.workspace.session!.id, "collection.json"))).toBe(true); expect(s.faux.state.callCount).toBe(1); s.app.dispose();
  });
  it("模型验证经过单独确认，只请求一次且无工具，设置上限不被放大", async () => {
    const s = fixture(); let sent: SimpleStreamOptions | undefined, context = "";
    s.faux.setResponses([(value, options) => { sent = options; context = JSON.stringify(value); return fauxAssistantMessage("OK"); }]);
    s.workspace.prepare("modelProbe"); expect(s.faux.state.callCount).toBe(0); await s.workspace.confirm();
    expect(s.faux.state.callCount).toBe(1); expect(sent?.maxRetries).toBe(0); expect(sent?.maxTokens).toBe(128); expect(context).not.toContain("propose_question");
    expect(s.workspace.modelVerified).toBe(true); expect(files(s.cfg.importRoot).some((file) => readFileSync(file, "utf8").includes("OFFLINE_ONLY_MODEL_CREDENTIAL"))).toBe(false); s.app.dispose();
  });
  it("最终存档失败会阻止退出；恢复写入后只补存材料，不重发模型请求", async () => {
    const s = fixture(); const original = json.writeJsonAtomic;
    const spy = vi.spyOn(json, "writeJsonAtomic").mockImplementation((path, value) => {
      const state = value as { state?: string; metrics?: { requests: unknown[] } };
      if (path.endsWith("collection.json") && state.state === "ready" && state.metrics?.requests.length === 3) throw new Error("offline disk failure");
      return original(path, value);
    });
    try {
      s.answer(); s.workspace.input = "找一道数学题"; s.workspace.prepare("send"); await s.workspace.confirm();
      expect(s.workspace.message).toContain("disk failure"); await expect(s.workspace.stopAndWait()).rejects.toThrow("disk failure");
      spy.mockRestore(); await s.workspace.stopAndWait();
      expect(s.workspace.service.get(s.workspace.session!.id).state).toBe("ready"); expect(s.faux.state.callCount).toBe(3);
    } finally { spy.mockRestore(); s.app.dispose(); }
  });
  it("目标题数显示于发送摘要和实时进度，缺口按实际候选计算", async () => {
    const s = fixture(); s.workspace.setField("targetCount", "3");
    expect(() => s.workspace.setField("maxCandidates", "2")).toThrow("目标题数");
    expect(s.workspace.config.limits.maxCandidates).toBe(100);
    s.workspace.prepare("send", "搜集三道多学科题目");
    expect(s.workspace.confirmationDetails().join("\n")).toContain("目标题数：3"); s.workspace.back();
    await collect(s);
    expect(s.workspace.progress()).toMatchObject({ target: 3, accepted: 1, remaining: 2, targetReached: false });
    expect(s.workspace.message).toContain("还缺 2 题");
    expect(s.render(120).join("\n")).toContain("目标 3 · 有效候选 1 · 缺口 2");
    expect(() => s.workspace.setField("targetCount", "1")).toThrow("配置已固定"); s.app.dispose();
  });
  it("80×24 与宽窗口保留完整对话宽度，命令候选在输入栏下方", async () => {
    const s = fixture(); const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
      for (const page of ["chat", "settings", "candidates", "history"] as const) {
        s.workspace.page = page; const frame = s.app.render(80); expect(frame).toHaveLength(24); expect(frame.every((line) => visibleWidth(line) <= 80)).toBe(true);
        expect(stripTerminalSequences(frame.join("\n"))).toContain("返回");
      }
      s.workspace.page = "chat"; s.workspace.input = ""; Object.defineProperty(process.stdout, "rows", { configurable: true, value: 50 });
      const before = s.app.render(180); s.app.handleInput("/"); const after = s.app.render(180);
      expect(before.join("\n")).not.toMatch(/▀{24}/);
      expect(after.join("\n")).not.toMatch(/▀{24}/);
      const plain = after.map(stripTerminalSequences);
      const input = plain.findIndex((line) => line.includes("› /"));
      expect(input).toBeGreaterThan(0);
      expect(plain.findIndex((line) => line.includes("/run"))).toBeGreaterThan(input);
      expect(after.every((line) => visibleWidth(line) <= 180)).toBe(true);
      s.app.handleInput("\x1b"); expect(s.workspace.page).toBe("chat");
    } finally { if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows"); s.app.dispose(); }
  });
});
