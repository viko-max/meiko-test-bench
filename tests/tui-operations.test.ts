import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ExamApp, SLOGAN } from "../src/tui/app.js";
import { ExamTui } from "../src/tui/controller.js";
import { TaskControlService } from "../src/service/task-service.js";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { runBatch } from "../src/runner/batch.js";
import { EXAM_TOOLS_VERSION } from "../src/tools/index.js";
import { readManifest } from "../src/runner/answer-source.js";
import { visibleWidth, stripTerminalSequences, sliceByColumn } from "@earendil-works/pi-tui";
import { prepareMascotImage, renderMascotImage } from "../src/tui/mascot.js";
import { OPENING_DURATION_MS, PAGE_ENTRANCE_DURATION_MS } from "../src/tui/opening.js";

beforeAll(async () => prepareMascotImage());

// 仅生成离线验证材料，保留在项目 .work 中，不修改正式题目和运行结果。
function fixture() {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "tui-verification-"));
  const dir = join(root, "datasets", "demo");
  mkdirSync(join(dir, "public"), { recursive: true });
  mkdirSync(join(dir, "scoring"));
  writeFileSync(join(dir, "public", "q1.md"), '---\nid: q1\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\n求力 F。\n');
  writeFileSync(join(dir, "scoring", "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", reference: "6", units: ["N"], tolerance: 0.01, deterministicLocked: true, maxScore: 10 }));
  const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }], capability: {} });
  const modelsConfigPath = join(root, "models.json");
  writeFileSync(modelsConfigPath, JSON.stringify({ version: "1", profiles: [profile] }));
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("F = 6 N")));
  const models = createModels();
  models.setProvider(faux.provider);
  const cfg = { datasetsRoot: join(root, "datasets"), modelsConfigPath, runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: EXAM_TOOLS_VERSION, pythonInterpreter: "python", registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  const service = new TaskControlService();
  const tui = new ExamTui(cfg, service);
  tui.loadDatasets();
  const app = new ExamApp(tui);
  app.rerender = vi.fn();
  return { root, dir, cfg, faux, service, tui, app };
}

async function flush() {
  await new Promise<void>((done) => setImmediate(done));
}
afterEach(() => vi.restoreAllMocks());

describe("TUI 异步操作和任务生命周期", () => {
  it("首页用多行像素字标，以命令栏进入历史任务", async () => {
    const s = fixture();
    await s.tui.gotoHome();
    const lines = s.app.render(80);
    const output = lines.join("\n");
    expect(output).toContain("█");
    expect(output).toContain("▄");
    expect(output).not.toContain("1首页");
    expect(output).not.toContain("┌");
    expect(output).toContain(SLOGAN);
    expect(output).not.toContain("/run");
    expect(output).not.toContain("/import");
    expect(output).toContain("/ 命令");
    expect(stripTerminalSequences(output)).toContain("输入消息，或 / 查看命令");
    expect(output).not.toContain("\x1b[90m");
    for (const char of "/tasks") s.app.handleInput(char);
    s.app.handleInput("\r");
    await flush();
    expect(s.tui.getState().screen.kind).toBe("tasks");
  });

  it("首页命令候选项的鼠标操作可以打开对应页面", async () => {
    const s = fixture();
    await s.tui.gotoHome();
    s.app.handleInput("/");
    const lines = s.app.render(80);
    const row = lines.findIndex((line) => line.includes("/tasks"));
    expect(s.app.handleMouse({ type: "click", button: "left", x: 40, y: row } as Parameters<ExamApp["handleMouse"]>[0])).toEqual({ handled: true });
    await flush();
    expect(s.tui.getState().screen.kind).toBe("tasks");
  });

  it("题集选择页按 Esc 返回首页", async () => {
    const s = fixture();
    await s.tui.gotoHome();
    for (const char of "/run") s.app.handleInput(char);
    s.app.handleInput("\r");
    await flush();
    expect(s.tui.getState().screen.kind).toBe("datasets");
    expect(s.app.render(80).join("\n")).toContain("esc返回首页");
    s.app.handleInput("\x1b");
    await flush();
    expect(s.tui.getState().screen.kind).toBe("home");
  });

  it("开场角色会移动，品牌可读，任意键跳过且不制造加载进度", async () => {
    const s = fixture();
    await s.tui.begin();
    vi.useFakeTimers();
    try {
      s.app.startOpening();
      const first = s.app.render(80).join("\n");
      expect(first).not.toContain("▱");
      vi.advanceTimersByTime(1000);
      const output = s.app.render(80).join("\n");
      expect(output).toContain("█");
      expect(output).not.toBe(first);
      expect(output).not.toContain("\x1b[48;2;0;42;50m");
      vi.advanceTimersByTime(500);
      const settling = s.app.render(128);
      for (const line of settling) expect(typeof line).toBe("string");
      expect(settling.join("\n")).toContain("跳过");
    } finally {
      s.app.dispose();
      vi.useRealTimers();
    }
  });

  it("开场播放结束进入首页，跳过不会再次触发过渡", async () => {
    const s = fixture();
    await s.tui.begin();
    vi.useFakeTimers();
    try {
      s.app.startOpening();
      await vi.advanceTimersByTimeAsync(OPENING_DURATION_MS);
      expect(s.tui.getState().screen.kind).toBe("home");
      expect(vi.getTimerCount()).toBe(0);
      await s.tui.begin();
      s.app.startOpening();
      s.app.handleInput("\x1b");
      await vi.advanceTimersByTimeAsync(0);
      expect(s.tui.getState().screen.kind).toBe("home");
      expect(vi.getTimerCount()).toBe(0);
    } finally { s.app.dispose(); vi.useRealTimers(); }
  });

  it("粉色与黑色在首次可见时分别挥手和点头，按键跳过仍打开命令", () => {
    const s = fixture();
    vi.spyOn(s.app as any, "termRows").mockReturnValue(50);
    const pose = (color: "pink" | "black", frame: "idle" | "waveOut" | "lookRight" | "nod") =>
      renderMascotImage(64, 32, undefined, frame, color, "entrance")[color === "pink" ? 26 : 17]!;
    vi.useFakeTimers();
    try {
      s.tui.gotoBank();
      s.app.render(80);
      expect(vi.getTimerCount()).toBe(0);
      s.app.render(160);
      vi.advanceTimersByTime(500);
      expect(s.app.render(160).join("\n")).toContain(pose("pink", "waveOut"));
      s.app.handleInput("/");
      const skipped = s.app.render(160).join("\n");
      expect(skipped).toContain(pose("pink", "idle"));
      expect(skipped).toContain("/run");
      expect(vi.getTimerCount()).toBe(0);
      s.app.handleInput("\x1b");
      s.tui.openSetup();
      s.app.render(160);
      vi.advanceTimersByTime(350);
      expect(s.app.render(160).join("\n")).toContain(pose("black", "lookRight"));
      vi.advanceTimersByTime(300);
      expect(s.app.render(160).join("\n")).toContain(pose("black", "nod"));
      vi.advanceTimersByTime(PAGE_ENTRANCE_DURATION_MS);
      expect(s.app.render(160).join("\n")).toContain(pose("black", "idle"));
      s.tui.gotoBank();
      expect(s.app.render(160).join("\n")).toContain(pose("pink", "idle"));
      expect(vi.getTimerCount()).toBe(0);
    } finally { s.app.dispose(); vi.useRealTimers(); }
  });

  it("动画中调整窗口不会截掉跳过提示，关闭动画直接显示首页", async () => {
    const s = fixture();
    await s.tui.begin();
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      for (const [width, height] of [[128, 38], [80, 24], [40, 16]]) {
        Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
        const lines = s.app.render(width!);
        expect(lines.length).toBeLessThanOrEqual(height!);
        expect(lines.join("\n")).toContain("跳过");
        if (width === 80) expect(stripTerminalSequences(lines.join("\n"))).not.toMatch(/▀{24}/);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
      }
      s.tui.toggleAnimation();
      await s.tui.begin();
      expect(s.tui.getState().screen.kind).toBe("home");
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
  });

  it("/run 只打开配置向导，重复提交也不直接发请求", async () => {
    const s = fixture();
    await s.tui.gotoHome();
    const start = vi.spyOn(s.service, "start");
    for (const char of "/run") s.app.handleInput(char);
    s.app.handleInput("\r");
    s.app.handleInput("\r");
    await flush();
    expect(s.tui.getState().screen.kind).toBe("datasets");
    expect(start).not.toHaveBeenCalled();
    expect(s.faux.state.callCount).toBe(0);
  });

  it("命令层 Esc 只关闭列表，第二次 Esc 才返回首页", async () => {
    const s = fixture();
    s.app.handleInput("/");
    s.app.handleInput("\x1b");
    expect(s.tui.getState().screen.kind).toBe("datasets");
    s.app.handleInput("\x1b");
    await flush();
    expect(s.tui.getState().screen.kind).toBe("home");
  });

  it("导入路径中的斜杠、q 和数字不会触发导航或退出", async () => {
    const s = fixture();
    const quit = vi.fn();
    s.app.setQuitHandler(quit);
    for (const char of "/import") s.app.handleInput(char);
    s.app.handleInput("\r");
    await flush();
    for (const char of "C:/question123.txt") s.app.handleInput(char);
    expect(s.app.render(100).join("\n")).toContain("C:/question123.txt");
    expect(quit).not.toHaveBeenCalled();
    s.app.handleInput("\x1b");
    expect(s.app.render(100).join("\n")).not.toContain("导入路径");
  });

  it("窗口变小时仍保留命令栏与错误，所有输出不超过列宽和高度", async () => {
    const s = fixture();
    await s.tui.gotoHome();
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      for (const [width, height] of [[128, 38], [80, 30], [40, 16], [24, 12]]) {
        Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
        s.app.handleInput("/");
        const lines = s.app.render(width!);
        expect(lines.length).toBeLessThanOrEqual(height!);
        expect(lines.some((line) => line.includes("›"))).toBe(true);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
        s.app.handleInput("\x1b");
      }
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
  });

  it.each([[136, 40, 64], [136, 28, 48], [136, 27, 0], [112, 28, 48], [111, 28, 48], [80, 24, 0]])("%s×%s 窗口按实际空间完整展示角色，保留完整输入栏", async (width, height, pixels) => {
    const s = fixture();
    await s.tui.gotoHome();
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
      const lines = s.app.render(width);
      const plain = lines.map(stripTerminalSequences);
      const spriteWidth = (text: string[]) => [64, 48].find((size) => text.some((line) => line.includes(renderMascotImage(size, size / 2, undefined, "idle", "orange", "entrance")[5]!))) ?? 0;
      expect(spriteWidth(lines)).toBe(pixels);
      expect(lines).toHaveLength(height);
      expect(plain.at(-1)).toContain("Ctrl+C 退出");
      const inputRow = plain.findIndex((line) => line.includes("输入消息，或 / 查看命令"));
      expect(inputRow).toBeGreaterThanOrEqual(0);
      s.app.handleInput("/");
      const openedLines = s.app.render(width);
      const opened = openedLines.map(stripTerminalSequences);
      expect(opened.join("\n")).toContain("↑↓ 选择");
      expect(spriteWidth(openedLines)).toBe(pixels);
      const expandedInput = opened.findIndex((line) => line.includes("› /"));
      expect(expandedInput).toBeLessThan(inputRow);
      expect(opened.findIndex((line) => line.includes("/run"))).toBeGreaterThan(expandedInput);
      const art = (rendered: string[]) => {
        if (!pixels) return [];
        const reference = renderMascotImage(pixels, pixels / 2, undefined, "idle", "orange", "entrance")[5]!;
        const row = rendered.findIndex((line) => line.includes(reference));
        expect(row).toBeGreaterThanOrEqual(5);
        const x = visibleWidth(rendered[row]!.slice(0, rendered[row]!.indexOf(reference)));
        return rendered.slice(row - 5, row - 5 + pixels / 2).map((line) => sliceByColumn(line, x, pixels));
      };
      expect(art(openedLines)).toEqual(art(lines));
      s.app.handleInput("\x1b");
      s.tui.setMessage("测试提示");
      const withMessage = s.app.render(width);
      expect(stripTerminalSequences(withMessage.join("\n"))).toContain("测试提示");
      expect(art(withMessage)).toEqual(art(lines));
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      await s.tui.begin();
      const intro = s.app.render(width);
      expect(spriteWidth(intro)).toBe(pixels);
      expect(intro.join("\n")).toContain("跳过");
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
  });

  it("概览页显示完整配色角色，侧栏和命令点击坐标保持正确", async () => {
    const s = fixture();
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
      await s.tui.gotoHome();
      expect(s.app.render(136).join("\n")).toContain(renderMascotImage(64, 32, undefined, "idle", "orange", "entrance")[5]);
      s.tui.gotoBank();
      const bank = s.app.render(136);
      expect(bank.join("\n")).toContain(renderMascotImage(48, 24, undefined, "idle", "pink", "entrance")[5]);
      expect(stripTerminalSequences(bank[0]!)).toContain("题库");
      const row = bank.findIndex((line) => line.includes("demo"));
      expect(s.app.handleMouse({ type: "click", button: "left", x: 58, y: row } as Parameters<ExamApp["handleMouse"]>[0])).toEqual({ handled: true });
      await flush();
      expect(s.tui.getState().screen.kind).toBe("check");
      await s.tui.openTasks();
      const tasks = s.app.render(136);
      expect(tasks.join("\n")).toContain(renderMascotImage(48, 24, undefined, "idle", "black", "entrance")[5]);
      s.app.handleInput("/");
      const commands = s.app.render(136);
      const homeRow = commands.findIndex((line) => line.includes("/tasks"));
      expect(s.app.handleMouse({ type: "click", button: "left", x: 58, y: homeRow } as Parameters<ExamApp["handleMouse"]>[0])).toEqual({ handled: true });
      await flush();
      expect(s.tui.getState().screen.kind).toBe("tasks");
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
  });

  it("未启动任务时也能从首页查看历史，返回当前任务有明确提示", async () => {
    const s = fixture();
    s.app.handleInput("h");
    await flush();
    expect(s.tui.getState().screen.kind).toBe("tasks");
    s.app.handleInput("r");
    expect(s.tui.getState().message).toContain("当前会话没有任务");
  });
  it("按下 Enter 后检查完成会主动刷新，无需第二个按键", async () => {
    const s = fixture();
    s.app.handleInput("\r");
    await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("check"));
    expect(s.app.rerender).toHaveBeenCalled();
  });

  it("鼠标选择题集也在异步完成后刷新", async () => {
    const s = fixture();
    const lines = s.app.render(80);
    const y = lines.findIndex((line) => line.includes("demo"));
    expect(s.app.handleMouse({ type: "click", button: "left", x: 3, y } as Parameters<ExamApp["handleMouse"]>[0])).toEqual({ handled: true });
    await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("check"));
    expect(s.app.rerender).toHaveBeenCalled();
  });

  it("边界操作失败会显示错误，不产生未处理的异步异常", async () => {
    const s = fixture();
    vi.spyOn(s.tui, "checkDataset").mockRejectedValue(new Error("题集无法读取"));
    s.app.handleInput("\r");
    await flush();
    expect(s.tui.getState().message).toBe("题集无法读取");
    expect(s.app.render(80).join("\n")).toContain("题集无法读取");
  });

  it("历史列表超过 20 条仍可查看末项，选择不会超出列表", async () => {
    const s = fixture();
    vi.spyOn(s.service, "listTasks").mockReturnValue(Array.from({ length: 25 }, (_, i) => ({ runId: `history-${i}`, trialCount: 1, hasReport: true })));
    await s.tui.openTasks();
    for (let i = 0; i < 40; i++) s.app.handleInput("\x1b[B");
    expect(s.app.render(80).join("\n")).toContain("history-24");
    const open = vi.spyOn(s.tui, "openDetail").mockResolvedValue();
    s.app.handleInput("\r");
    await flush();
    expect(open).toHaveBeenCalledWith("history-24");
  });

  it("长任务编号保留唯一末尾与题数，中文列宽不超出终端", async () => {
    const s = fixture();
    vi.spyOn(s.service, "listTasks").mockReturnValue([{ runId: "学科".repeat(30) + "__unique-tail-42", trialCount: 40, hasReport: true }]);
    await s.tui.openTasks();
    const row = s.app.render(80).find((line) => line.includes("unique-tail-42"))!;
    expect(row).toContain("40 题");
    expect(visibleWidth(row)).toBeLessThanOrEqual(80);
  });

  it("切换页面后不能覆盖尚未结束的任务，包括等待停止期间", async () => {
    const s = fixture();
    let complete!: () => void;
    const pending = new Promise<undefined>((done) => { complete = () => done(undefined); });
    const start = vi.spyOn(s.service, "start").mockReturnValue("active-task");
    vi.spyOn(s.service, "whenDone").mockReturnValue(pending);
    await s.tui.checkDataset("demo");
    const setup = { profileId: "faux", modelId: "faux-1", mode: "without_tool" as const, concurrency: 1 };
    s.tui.setSetup(setup);
    expect(s.tui.start()).toBe("active-task");
    s.tui.gotoDatasets();
    s.tui.setSetup(setup);
    expect(s.tui.start()).toBeUndefined();
    s.tui.stop();
    s.tui.setSetup(setup);
    expect(s.tui.start()).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
    complete();
    await flush();
    s.tui.setSetup(setup);
    expect(s.tui.start()).toBe("active-task");
  });

  it("退出等待正在进行的界面操作，再停止任务和关闭终端", async () => {
    const s = fixture();
    let finish!: () => void;
    vi.spyOn(s.tui, "checkDataset").mockImplementation(() => new Promise((done) => {
      finish = () => done({ datasetId: "demo", total: 1, confirmed: 1, errors: [], missingImages: [], missingScoring: [], plannedMax: 10 });
    }));
    const stop = vi.spyOn(s.tui, "stopAndWait").mockResolvedValue();
    const quit = vi.fn();
    s.app.setQuitHandler(quit);
    s.app.handleInput("\r");
    await flush();
    s.app.handleInput("q");
    await flush();
    expect(stop).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("未产生运行事件的启动失败仍能刷新并显示实际失败状态", async () => {
    const s = fixture();
    await s.tui.checkDataset("demo");
    s.tui.setSetup({ profileId: "missing-profile", modelId: "missing-model", mode: "without_tool", concurrency: 1 });
    s.app.handleInput("\r");
    await vi.waitFor(() => {
      const id = s.tui.getState().taskId;
      expect(id).toBeTruthy();
      expect(s.service.getStatus(id!)?.state).toBe("error");
    });
    expect(s.app.render(80).join("\n")).toContain("任务失败");
    expect(s.app.rerender).toHaveBeenCalled();
  });

  it("两种模式的续跑详情均显示复用答卷和对应成绩，不增加模型请求", async () => {
    const s = fixture();
    const params = { datasetId: "demo", datasetDir: s.dir, modes: ["without_tool", "with_tool"] as Array<"without_tool" | "with_tool">, profileId: "faux", modelId: "faux-1", limit: 1, ...s.cfg };
    await runBatch(params);
    const resumed = await runBatch(params);
    for (const mode of params.modes) {
      const runId = resumed.byMode[mode]!.runId;
      await s.tui.openDetail(runId);
      const screen = s.tui.getState().screen;
      if (screen.kind !== "detail") throw new Error("expected detail");
      expect(screen.detail.questions).toHaveLength(1);
      expect(screen.detail.questions[0]!.finalAnswerSheet).toBe("F = 6 N");
      expect(screen.detail.report?.totals.confirmedRaw).toBe(10);
      await s.tui.openReport(runId);
      expect(s.tui.getState().screen.kind).toBe("report");
    }
    expect(s.faux.state.callCount).toBe(2);
  });

  it("仅剩 attempt 的记录在详情中显示未知，旧评分不计入", async () => {
    const s = fixture();
    const result = await runBatch({ datasetId: "demo", datasetDir: s.dir, modes: ["without_tool"], profileId: "faux", modelId: "faux-1", limit: 1, ...s.cfg });
    const runId = result.byMode.without_tool!.runId;
    const source = readManifest(s.cfg.runsRoot, runId)!.sources[0]!;
    const dir = join(s.cfg.runsRoot, source.runId, "trials", source.trialId);
    renameSync(join(dir, "trial.json"), join(dir, "saved-trial.json"));
    await s.tui.openDetail(runId);
    const screen = s.tui.getState().screen;
    if (screen.kind !== "detail") throw new Error("expected detail");
    expect(screen.detail.questions[0]!.executionStatus).toBe("outcome_unknown");
    expect(screen.detail.questions[0]!.grade).toBeUndefined();
    expect(screen.detail.report!.totals.confirmedRaw).toBe(0);
    expect(s.faux.state.callCount).toBe(1);
  });
});
