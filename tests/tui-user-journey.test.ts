import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { prepareMascotImage } from "../src/tui/mascot.js";

describe("用户通过 TUI 完成整次测评", () => {
  it("导入、核对、入库、双模式、真实工具、指标、复核与续跑均由界面入口串联", async () => {
    await prepareMascotImage();
    mkdirSync(resolve(".work"), { recursive: true });
    const root = mkdtempSync(resolve(".work", "tui-journey-"));
    const source = join(root, "source.json"), datasetsRoot = join(root, "datasets");
    // 这些材料与模型响应仅验证程序行为；公开题面不包含私有评分标记。
    writeFileSync(source, JSON.stringify({ questions: [
      { id: "c-choice", subject: "math", answer_kind: "single_choice", question: "计算 2+2。", options: { A: "3", B: "4" }, answer: "B", maxScore: 1 },
      { id: "n-number", subject: "physics", answer_kind: "numeric_unit", question: "计算 3+4。", answer: "7", maxScore: 1 },
      { id: "o-open", subject: "chemistry", answer_kind: "open", question: "说明核对计算结果的方法。", answer: "PRIVATE_JOURNEY_STANDARD", maxScore: 2 },
    ] }));
    const profile = ModelProfileSchema.parse({ id: "journey", displayName: "离线验收接口", provider: "journey-test", api: "faux",
      baseUrl: "https://offline.example/v1", auth: { envVars: ["OFFLINE_JOURNEY_KEY"] },
      models: [{ id: "journey", name: "离线验收模型", input: ["text"], contextWindow: 32768, maxTokens: 4096 }] });
    const model = profile.models[0]!;
    const faux = fauxProvider({ provider: profile.provider, models: [model] }), models = createModels();
    models.setProvider(faux.provider);
    const contexts: string[] = [];
    const replies = ["Answer: B", "Answer: 7", "通过独立方法核对结果。", "Answer: B",
      fauxToolCall("execute_typescript", { code: "console.log(3 + 4);" }), "Answer: 7", "通过独立方法核对结果。"];
    faux.setResponses(replies.map((reply) => (context) => { contexts.push(JSON.stringify(context)); return fauxAssistantMessage(reply); }));
    const modelsConfigPath = join(root, "models.json");
    writeFileSync(modelsConfigPath, JSON.stringify({ version: "1", profiles: [profile] }));
    const cfg = { datasetsRoot, modelsConfigPath, runsRoot: join(root, "runs"), workRoot: join(root, "work"), importRoot: join(root, "drafts"),
      toolsVersion: "v1", pythonInterpreter: "python", animation: false, registryOverride: { models, profilesById: new Map([[profile.id, profile]]) } };
    const tui = new ExamTui(cfg), app = new ExamApp(tui);
    app.rerender = vi.fn();
    vi.spyOn(app as any, "termRows").mockReturnValue(24);
    const type = (text: string) => { for (const char of text) app.handleInput(char); };
    const enter = () => app.handleInput("\r");
    const screen = () => tui.getState().screen;
    const expectScreen = async (kind: string) => vi.waitFor(() => expect(screen().kind).toBe(kind));
    const render = () => {
      const lines = app.render(80);
      expect(lines.length).toBeLessThanOrEqual(24);
      expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
      return lines.map(stripTerminalSequences).join("\n");
    };
    const command = async (name: string) => { type(`/${name}`); enter(); await new Promise<void>((done) => setImmediate(done)); };
    try {
      await tui.gotoHome();
      expect(render()).toContain("Creative Is All You Need");
      await command("import");
      expect(render()).toContain("导入路径");
      type(source); enter(); type("journey"); enter(); type("1"); enter();
      await expectScreen("importPreview");
      expect(existsSync(join(datasetsRoot, "journey"))).toBe(false);
      app.handleInput("v"); await expectScreen("draftQuestion");
      const draft = screen();
      if (draft.kind !== "draftQuestion") throw new Error("草稿核对页面未打开。");
      expect(draft.review.modelText).toContain("计算 2+2");
      expect(draft.review.modelText).not.toContain("PRIVATE_JOURNEY_STANDARD");
      render(); app.handleInput("\x1b"); await expectScreen("importPreview");
      enter(); await expectScreen("bank");
      expect(existsSync(join(datasetsRoot, "journey", "VERSION.json"))).toBe(true);
      await command("run"); await expectScreen("datasets");
      expect(tui.getState().datasets.map((dataset) => dataset.id)).toContain("journey");
      enter(); await expectScreen("check");
      expect(render()).toContain("3");
      enter(); await expectScreen("setup");
      const setup = screen();
      if (setup.kind !== "setup") throw new Error("模型配置页面未打开。");
      const index = setup.groups.findIndex((group) => group.providerId === profile.provider);
      expect(index).toBeGreaterThanOrEqual(0);
      for (let i = setup.providerIndex; i < index; i++) app.handleInput("\x1b[B");
      for (let i = setup.providerIndex; i > index; i--) app.handleInput("\x1b[A");
      enter(); await expectScreen("pickmodel"); enter(); await expectScreen("confirm");
      const chosen = screen();
      expect(chosen.kind === "confirm" && chosen.setup.profileId).toBe(profile.id);
      app.handleInput("\x1b"); await expectScreen("pickmodel");
      const back = screen();
      expect(back.kind === "pickmodel" && back.setup.profileId).toBe(profile.id);
      enter(); await expectScreen("confirm");
      app.handleInput("m"); app.handleInput("m");
      const confirm = screen();
      expect(confirm.kind === "confirm" && confirm.setup.mode).toBe("both");
      render(); enter(); await expectScreen("run");
      const taskId = tui.getState().taskId!;
      const status = await tui.getService().whenDone(taskId);
      expect(status?.state).toBe("done");
      expect(status?.runIds).toHaveLength(2);
      expect(faux.state.callCount).toBe(7);
      expect(contexts.every((context) => !context.includes("PRIVATE_JOURNEY_STANDARD"))).toBe(true);
      expect(contexts.some((context) => /--- stdout ---\\n7/.test(context))).toBe(true);
      const runtime = render();
      expect(runtime).toContain("Token");
      expect(runtime).toContain("TPS");
      expect(runtime).toContain("未提供");
      await command("results"); await expectScreen("report");
      const result = screen();
      expect(result.kind === "report" && result.mode).toBe("with_tool");
      expect(result.kind === "report" && result.report.totals).toEqual({ confirmedRaw: 2, confirmedMax: 2, plannedMax: 4 });
      app.handleInput("m"); await vi.waitFor(() => { const value = screen(); expect(value.kind === "report" && value.mode).toBe("without_tool"); });
      await command("review"); await expectScreen("review");
      expect(render()).toContain("o-open");
      for (const [key, text] of [["s", "2"], ["c", "offline-reviewer"], ["e", "仅确认离线验收材料的评分流程"]]) { app.handleInput(key!); type(text!); enter(); }
      enter(); await vi.waitFor(() => { const value = screen(); expect(value.kind === "review" && value.confirming).toBe(true); });
      expect(render()).toContain("确认保存");
      app.handleInput("y"); await vi.waitFor(() => { const value = screen(); expect(value.kind === "review" && value.items.length).toBe(0); });
      const latest = tui.getService().listTasks(cfg.runsRoot)[0]!;
      const confirmed = await tui.getService().rebuildReport(cfg.runsRoot, latest.runId, join(datasetsRoot, "journey"), "journey", "with_tool");
      expect(confirmed.totals).toEqual({ confirmedRaw: 4, confirmedMax: 4, plannedMax: 4 });
      await command("tasks"); await expectScreen("tasks"); enter(); await expectScreen("detail");
      app.handleInput("v"); await expectScreen("confirm");
      expect(render()).toContain("续跑");
      enter(); await expectScreen("run");
      await tui.getService().whenDone(tui.getState().taskId!);
      expect(faux.state.callCount).toBe(7);
      let quit = false;
      app.setQuitHandler(() => { quit = true; });
      await command("quit"); await vi.waitFor(() => expect(quit).toBe(true));
      expect(readFileSync(join(datasetsRoot, "journey", "public", "o-open.md"), "utf8")).not.toContain("PRIVATE_JOURNEY_STANDARD");
    } finally { app.dispose(); vi.restoreAllMocks(); }
  }, 30000);
});
