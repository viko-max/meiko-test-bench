import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ExamApp } from "../src/tui/app.js";
import { ExamTui } from "../src/tui/controller.js";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { prepareMascotImage } from "../src/tui/mascot.js";

beforeAll(prepareMascotImage, 20000);
afterEach(() => vi.restoreAllMocks());
function fixture() {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "chat-tui-"));
  const faux = fauxProvider({ provider: "chat-ui", models: ["model-a", "model-b"].map((id) => ({ id, reasoning: true, maxTokens: 4096, contextWindow: 32768 })) });
  const models = createModels(); models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "chat-ui", provider: "chat-ui", displayName: "离线聊天验证", api: "faux", baseUrl: "https://offline.example/v1", auth: { envVars: ["OFFLINE_CHAT_UI_KEY"] },
    models: ["model-a", "model-b"].map((id) => ({ id, name: id, input: ["text"], reasoning: true, maxTokens: 4096, contextWindow: 32768 })) });
  const cfg = { datasetsRoot: join(root, "datasets"), runsRoot: join(root, "runs"), workRoot: join(root, "work"), chatRoot: join(root, "chats"), modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python", animation: false, registryOverride: { models, profilesById: new Map([[profile.id, profile]]) } };
  const tui = new ExamTui(cfg), app = new ExamApp(tui);
  let rows = 24; vi.spyOn(app as any, "termRows").mockImplementation(() => rows);
  const type = (text: string) => { for (const char of text) app.handleInput(char); };
  const enter = () => app.handleInput("\r");
  const render = (width = 80, height = 24) => { rows = height; const lines = app.render(width); expect(lines).toHaveLength(height); expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true); return lines.map(stripTerminalSequences).join("\n"); };
  const command = async (name: string) => { type(`/${name}`); enter(); await new Promise<void>((done) => setImmediate(done)); render(); };
  return { root, cfg, faux, tui, app, type, enter, render, command, actualEndpoint: models.getModel(profile.provider, "model-a")!.baseUrl, workspace: () => tui.getChatWorkspace() };
}
async function finish(s: ReturnType<typeof fixture>, calls: number) {
  await vi.waitFor(() => { expect(s.faux.state.callCount).toBe(calls); expect(s.workspace().busy).toBe(false); expect(s.workspace().session?.turns.at(-1)?.status).toBe("completed"); });
  s.render();
}
async function firstTurn(s: ReturnType<typeof fixture>, text = "解释动量守恒") {
  await s.tui.gotoHome(); s.render(); s.type(text); s.enter();
  await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("chat"));
  expect(s.workspace().page).toBe("confirm"); s.render(); s.enter(); await finish(s, 1);
}

describe("独立聊天的 TUI 完整流程", () => {
  it("首页直接输入消息，首次确认后开始流式对话；后续 Enter 继续聊天", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("第一轮离线回答"), fauxAssistantMessage("第二轮离线回答")]);
    try {
      await s.tui.gotoHome(); const before = s.render(); s.type("解释动量守恒");
      expect(s.render()).not.toContain("/run"); expect(s.render().split("\n").length).toBe(before.split("\n").length);
      s.enter(); await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("chat"));
      expect(s.render()).toContain("确认此会话"); expect(s.render()).toContain(s.actualEndpoint); expect(s.faux.state.callCount).toBe(0);
      s.enter(); await finish(s, 1); expect(s.render()).toContain("第一轮离线回答"); expect(s.workspace().input).toBe("");
      s.type("再举一个例子"); s.enter(); await finish(s, 2); expect(s.workspace().input).toBe("");
      expect(s.workspace().session?.turns).toHaveLength(2); expect(s.render()).toContain("TPS"); expect(s.render()).toContain("上下文估算");
      expect(existsSync(s.cfg.runsRoot)).toBe(false);
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });
  it("/chat 和 /model 仅打开界面；模型切换重新确认并沿用预算", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("模型 A 回答"), fauxAssistantMessage("模型 B 回答")]);
    try {
      await firstTurn(s); const id = s.workspace().session!.id, before = s.workspace().service.budget(id)!.knownTokens;
      await s.command("model"); expect(s.workspace().page).toBe("models"); expect(s.faux.state.callCount).toBe(1);
      s.app.handleInput("\x1b[B"); s.enter(); s.render(); expect(s.workspace().config.modelId).toBe("model-b");
      s.type("换一个模型继续"); s.enter(); expect(s.workspace().page).toBe("confirm"); expect(s.faux.state.callCount).toBe(1);
      s.render(); s.enter(); await finish(s, 2);
      expect(s.workspace().session!.id).toBe(id); expect(s.workspace().service.budget(id)!.knownTokens).toBeGreaterThan(before);
      expect(s.workspace().session!.turns.map((turn) => turn.model.modelId)).toEqual(["model-a", "model-b"]);
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });
  it("聊天历史与新对话分开，重新读取历史不会发请求", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("历史回答")]);
    try {
      await firstTurn(s, "历史问题"); const id = s.workspace().session!.id;
      s.workspace().newConversation(); s.workspace().history(); expect(s.render()).toContain("历史问题");
      s.enter(); expect(s.workspace().session!.id).toBe(id); expect(s.render()).toContain("历史回答"); expect(s.faux.state.callCount).toBe(1);
      s.app.handleInput("\x1b"); await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("home"));
      await s.command("chat"); expect(s.workspace().session!.id).toBe(id); expect(s.faux.state.callCount).toBe(1);
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });
  it("q、数字和句中的斜杠都是聊天文本，空输入的斜杠才打开菜单", async () => {
    const s = fixture(); let exited = false; s.app.setQuitHandler(() => { exited = true; });
    try {
      await s.tui.gotoHome(); await s.command("chat"); s.type("q123 / 是什么意思");
      expect(s.workspace().input).toBe("q123 / 是什么意思"); expect(exited).toBe(false);
      s.workspace().input = ""; s.render(); s.app.handleInput("/"); const frame = s.render();
      expect(frame).toContain("/run"); expect(frame).toContain("/collect"); s.app.handleInput("\x1b");
      expect(s.tui.getState().screen.kind).toBe("chat"); expect(s.faux.state.callCount).toBe(0);
    } finally { s.app.dispose(); }
  });
  it("80×24 和宽窗口均保留输入、指标与操作；历史可向上阅读", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("完整长正文".repeat(600) + "\n" + Array.from({ length: 50 }, (_, index) => `离线正文第 ${index} 行`).join("\n"))]);
    try {
      await firstTurn(s); expect(s.render()).toContain("第 49 行"); s.app.handleInput("\x1b[5~"); expect(s.render()).not.toContain("第 49 行");
      for (const [width, height] of [[80, 24], [136, 40]]) {
        const frame = s.render(width, height); expect(frame).toContain("TPS"); expect(frame).toContain("停止"); expect(frame).toContain("Enter 发送");
      }
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });
  it("退出取消正在进行的回复并等待存档，只有一次提供方调用", async () => {
    const s = fixture(); let entered = false, exited = false;
    s.faux.setResponses([async (_context, options) => { entered = true; await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("offline abort")), { once: true })); return fauxAssistantMessage("不能继续"); }]);
    s.app.setQuitHandler(() => { exited = true; });
    try {
      await s.tui.gotoHome(); s.render(); s.type("慢速离线响应"); s.enter(); await vi.waitFor(() => expect(s.workspace().page).toBe("confirm")); s.render(); s.enter();
      await vi.waitFor(() => expect(entered).toBe(true)); s.app.handleInput("\x03");
      await vi.waitFor(() => expect(exited).toBe(true)); expect(s.workspace().session?.turns[0]?.status).toBe("cancelled"); expect(s.faux.state.callCount).toBe(1);
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });
  it("聊天存档失败仍取消其他任务，退出错误明确暴露", async () => {
    const s = fixture(); const service = s.tui.getService();
    s.tui.getState().taskId = "offline-task";
    const stop = vi.spyOn(service, "stop").mockImplementation(() => {}), done = vi.spyOn(service, "whenDone").mockResolvedValue(undefined);
    const flush = vi.spyOn(s.workspace().service, "flush").mockImplementation(() => { throw new Error("offline chat disk failure"); });
    try { await expect(s.tui.stopAndWait()).rejects.toThrow("offline chat disk failure"); expect(stop).toHaveBeenCalledWith("offline-task"); expect(done).toHaveBeenCalledWith("offline-task"); }
    finally { flush.mockRestore(); s.app.dispose(); }
  });
  it("配置变化让旧发送摘要失效，确认页不伪装成聊天输入框", async () => {
    const s = fixture();
    try {
      await s.tui.gotoHome(); s.render(); s.type("确认前改变参数"); s.enter();
      await vi.waitFor(() => expect(s.workspace().page).toBe("confirm"));
      const frame = s.render(); expect(frame).toContain("Enter 确认并发送"); expect(frame).not.toContain("输入消息，或 / 查看命令");
      s.workspace().setField("maxOutputTokens", "512");
      await expect(s.workspace().confirm()).rejects.toThrow("发送摘要已变化"); expect(s.faux.state.callCount).toBe(0);
      expect(s.workspace().session).toBeUndefined();
    } finally { s.app.dispose(); }
  });

  // --- 原生搜索开关相关的离线测试 ---

  function mockNativeSearchSupport(s: ReturnType<typeof fixture>, support: { supported: boolean; status: string; reason: string | null }) {
    const service = s.workspace().service as any;
    const own = Object.getOwnPropertyDescriptor(service, "nativeSearchSupport");
    const proto = Object.getPrototypeOf(service) as object | null;
    const inherited = proto ? Object.getOwnPropertyDescriptor(proto, "nativeSearchSupport") : undefined;
    const descriptor = own ?? inherited;
    if (descriptor && typeof descriptor.get === "function") return vi.spyOn(service, "nativeSearchSupport", "get").mockReturnValue(support);
    if (descriptor && typeof descriptor.value !== "function") return vi.spyOn(service, "nativeSearchSupport", "get").mockReturnValue(support);
    return vi.spyOn(service, "nativeSearchSupport").mockReturnValue(support);
  }
  function enableProfileNativeSearch(s: ReturnType<typeof fixture>) {
    const map = s.cfg.registryOverride.profilesById as unknown as Map<string, any>;
    const profile = map.get("chat-ui");
    const capability = { ...(profile?.capability ?? {}), nativeWebSearch: "verified" };
    try { profile.capability = capability; } catch { /* 只读对象回退到替换映射项 */ }
    if (profile?.capability?.nativeWebSearch !== "verified") map.set("chat-ui", { ...profile, capability });
  }
  async function gotoSettings(s: ReturnType<typeof fixture>) {
    const ws = s.workspace() as any;
    try { ws.page = "settings"; } catch { /* 只读属性回退到命令入口 */ }
    if (ws.page === "settings") return;
    if (typeof ws.openSettings === "function") { await ws.openSettings(); return; }
    await s.command("settings");
  }
  async function gotoChat(s: ReturnType<typeof fixture>) {
    const ws = s.workspace() as any;
    try { ws.page = "chat"; } catch { /* 只读属性回退到 Esc */ }
    if (ws.page === "chat") return;
    s.app.handleInput("\x1b");
    await vi.waitFor(() => expect(ws.page).toBe("chat"));
  }

  it("新对话与切换模型都会关闭原生搜索", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("第一轮离线回答"), fauxAssistantMessage("第二轮离线回答")]);
    try {
      await firstTurn(s);
      const ws = s.workspace() as any;
      mockNativeSearchSupport(s, { supported: true, status: "verified", reason: null });
      enableProfileNativeSearch(s);
      await ws.toggleNativeSearch();
      expect(ws.config.nativeSearch).toBe(true);
      ws.newConversation();
      expect(ws.config.nativeSearch).toBe(false);
      await ws.toggleNativeSearch();
      expect(ws.config.nativeSearch).toBe(true);
      await ws.chooseModels();
      await ws.selectModel(1);
      await vi.waitFor(() => { expect(ws.config.modelId).toBe("model-b"); expect(ws.config.nativeSearch).toBe(false); });
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });

  it("历史恢复原生搜索开关，空历史关闭开关且不产生新请求", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("第一轮离线回答"), fauxAssistantMessage("允许原生搜索的第二轮回答")]);
    try {
      await firstTurn(s);
      const ws = s.workspace() as any;
      mockNativeSearchSupport(s, { supported: true, status: "verified", reason: null });
      enableProfileNativeSearch(s);
      await ws.toggleNativeSearch();
      expect(ws.config.nativeSearch).toBe(true);
      s.type("允许原生搜索的第二轮"); s.enter();
      await vi.waitFor(() => expect(ws.page).toBe("confirm"));
      s.render(); s.enter(); await finish(s, 2);
      expect(ws.session?.turns.at(-1)?.config.nativeSearch).toBe(true);
      const calls = s.faux.state.callCount;
      ws.newConversation();
      ws.history();
      ws.openHistory(0);
      await vi.waitFor(() => expect(ws.config.nativeSearch).toBe(true));
      expect(s.faux.state.callCount).toBe(calls);
      const empty = await ws.service.create(ws.config.maxTotalTokens);
      (ws.sessions as unknown as any[]).unshift(empty);
      ws.openHistory(0);
      await vi.waitFor(() => expect(ws.config.nativeSearch).toBe(false));
      expect(s.faux.state.callCount).toBe(calls);
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });

  it("不支持时无法开启，允许后可以直接关闭", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("第一轮离线回答")]);
    try {
      await firstTurn(s);
      const ws = s.workspace() as any;
      const unsupported = mockNativeSearchSupport(s, { supported: false, status: "unsupported", reason: "离线不支持" });
      await expect((async () => ws.toggleNativeSearch())()).rejects.toThrow("离线不支持");
      expect(ws.config.nativeSearch).toBe(false);
      unsupported.mockRestore();
      ws.config.nativeSearch = true;
      if (ws.config.nativeSearch !== true) { try { (s.workspace() as any).setField("nativeSearch", "true"); } catch { /* 保持直接赋值 */ } }
      expect(ws.config.nativeSearch).toBe(true);
      const check = mockNativeSearchSupport(s, { supported: true, status: "verified", reason: null });
      await ws.toggleNativeSearch();
      expect(ws.config.nativeSearch).toBe(false);
      expect(check).not.toHaveBeenCalled();
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });

  it("确认页展示原生搜索状态，未确认时不产生请求", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("离线回答"), fauxAssistantMessage("离线回答")]);
    try {
      await s.tui.gotoHome(); s.render(); s.type("第一条消息"); s.enter();
      await vi.waitFor(() => expect(s.workspace().page).toBe("confirm"));
      const closed = s.render().replace(/\s+/g, "");
      expect(closed).toContain("原生搜索关闭");
      expect(s.faux.state.callCount).toBe(0);
      s.app.handleInput("\x1b");
      await vi.waitFor(() => expect(["chat", "home"]).toContain(s.tui.getState().screen.kind));
      if (s.tui.getState().screen.kind === "home") { s.workspace().input = ""; await s.command("chat"); }
      const ws = s.workspace() as any;
      mockNativeSearchSupport(s, { supported: true, status: "verified", reason: null });
      enableProfileNativeSearch(s);
      await ws.toggleNativeSearch();
      expect(ws.config.nativeSearch).toBe(true);
      s.type("第二条消息"); s.enter();
      await vi.waitFor(() => expect(ws.page).toBe("confirm"));
      const allowed = s.render().replace(/\s+/g, "");
      expect(allowed).toContain("原生搜索已允许");
      expect(allowed).toContain("并非每轮必搜");
      expect(allowed).toContain("搜索词由模型生成并发送给Spark");
      expect(allowed).toContain("Token上限不是搜索费用的硬保证");
      expect(allowed).toContain("无AnySearch");
      expect(s.faux.state.callCount).toBe(0);
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });

  it("设置页展示原生搜索开关，w 键切换并保留输入区", async () => {
    const s = fixture(); s.faux.setResponses([fauxAssistantMessage("第一轮离线回答")]);
    try {
      await firstTurn(s);
      await gotoSettings(s);
      mockNativeSearchSupport(s, { supported: true, status: "verified", reason: null });
      enableProfileNativeSearch(s);
      const settings = s.render(80, 24);
      expect(settings).toContain("原生搜索");
      expect(settings).toContain("w 切换搜索");
      s.app.handleInput("w");
      await vi.waitFor(() => expect((s.workspace() as any).config.nativeSearch).toBe(true));
      const narrow = s.render(80, 24);
      const wide = s.render(136, 40);
      expect(narrow).toContain("开启");
      expect(wide).toContain("开启");
      if (!narrow.includes("本地工具关闭") && !wide.includes("本地工具关闭")) {
        await gotoChat(s);
        expect(s.render(80, 24)).toContain("本地工具关闭");
      }
      await gotoChat(s);
      const chat = s.render(80, 24);
      expect(chat).toContain("输入消息");
      expect(chat).toContain("停止");
      expect(chat).toContain("Enter 发送");
    } finally { await s.tui.stopAndWait(); s.app.dispose(); }
  });
});
