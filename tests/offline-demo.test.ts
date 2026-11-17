import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createDemoRegistry } from "../src/providers/offline-demo.js";
import { importDataset } from "../src/dataset/import.js";
import { ExamApp } from "../src/tui/app.js";
import { ExamTui } from "../src/tui/controller.js";
import { prepareMascotImage } from "../src/tui/mascot.js";
import { EXAM_TOOLS_VERSION } from "../src/tools/index.js";

it("能在超过 260 字符的绝对路径中验证随题原图", async () => {
  mkdirSync(".work", { recursive: true });
  const root = mkdtempSync(resolve(".work", "demo-long-path-"));
  const publicDir = join(root, "nested-import-".repeat(9), "attachment-source-".repeat(8));
  mkdirSync(join(publicDir, "figures"), { recursive: true });
  const source = join("datasets", "demo", "public");
  const image = join("figures", "seedling-height.png");
  expect(join(publicDir, image).length).toBeGreaterThan(260);
  copyFileSync(join(source, image), join(publicDir, image));
  copyFileSync(join(source, "demo-figure.md"), join(publicDir, "demo-figure.md"));
  const imported = await importDataset({ datasetId: "demo", publicDir });
  expect(imported.entries[0]?.errors).toEqual([]);
  expect(imported.ok).toBe(true);
});

it("从随附题包导入、查看原图、双模式作答、人工复核并从历史续跑", async () => {
  mkdirSync(".work", { recursive: true });
  const root = mkdtempSync(resolve(".work", "demo-acceptance-"));
  const sourcePath = join("datasets", "demo");
  const registry = await createDemoRegistry(sourcePath, 0);
  const datasetsRoot = join(root, "datasets");
  const runsRoot = join(root, "runs");
  const tui = new ExamTui({
    datasetsRoot, runsRoot, workRoot: join(root, "trials"), importRoot: join(root, "drafts"),
    modelsConfigPath: join(root, "absent-models.json"), toolsVersion: EXAM_TOOLS_VERSION, pythonInterpreter: "unused",
    offlineDemo: { sourcePath, registry }, animation: false,
  });
  const app = new ExamApp(tui);
  const screen = () => tui.getState().screen;
  const key = (data: string) => app.handleInput(data);
  const type = (text: string) => { for (const char of text) key(char); };
  const enter = () => key("\r");
  const render = (width = 80) => {
    const lines = app.render(width);
    expect(lines).toHaveLength(24);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    return lines.map(stripTerminalSequences).join("\n");
  };
  const waitForScreen = async (kind: string) => {
    await vi.waitFor(() => expect(screen().kind, tui.getState().message).toBe(kind), { timeout: 5000 });
    await new Promise<void>((done) => setImmediate(done));
  };
  const command = async (name: string, kind: string) => {
    type("/" + name); enter();
    await waitForScreen(kind);
  };
  vi.spyOn(app as unknown as { termRows(): number }, "termRows").mockReturnValue(24);

  try {
    await prepareMascotImage();
    await tui.begin();
    expect(render()).toContain("离线演示");
    key("/");
    const menu = render();
    expect(menu.indexOf("› /")).toBeGreaterThanOrEqual(0);
    expect(menu.indexOf("/run")).toBeGreaterThan(menu.indexOf("› /"));
    key("\x1b");

    await command("import", "home");
    expect(render()).toContain("导入路径");
    enter(); enter(); enter();
    await waitForScreen("importPreview");
    expect(render()).toContain("6 题");
    key("\x1b[B"); key("v"); await waitForScreen("draftQuestion");
    key("i"); await waitForScreen("draftImage");
    const picture = screen();
    if (picture.kind !== "draftImage") throw new Error("原图未打开。");
    expect([picture.image.width, picture.image.height]).toEqual([480, 300]);
    render(80);
    key("\x1b"); await waitForScreen("draftQuestion");
    key("\x1b"); await waitForScreen("importPreview");
    enter(); await waitForScreen("bank");
    expect(existsSync(join(datasetsRoot, "demo", "VERSION.json"))).toBe(true);

    await command("run", "datasets");
    enter(); await waitForScreen("check");
    const check = screen();
    if (check.kind !== "check") throw new Error("未打开检查页。");
    expect(check.report).toMatchObject({ confirmed: 6, errors: [], plannedMax: 9 });
    enter(); await waitForScreen("setup");
    const setup = screen();
    if (setup.kind !== "setup") throw new Error("未打开模型选择。");
    expect(setup.groups.map((group) => group.providerId)).toEqual(["meiko-offline-demo"]);
    enter(); await waitForScreen("pickmodel");
    enter(); await waitForScreen("confirm");
    expect(render()).toContain("执行离线演示");
    expect(render()).toContain("v2-restricted（受限计算、附件与图像工具）");
    expect(render()).toContain("模型自主选择工具；无任意 Python/TypeScript 执行");
    expect(render()).not.toContain("真实计费");
    enter(); await waitForScreen("run");
    const service = tui.getService();
    const status = await service.whenDone(tui.getState().taskId!);
    expect(status?.state, status?.error).toBe("done");
    expect(status?.runIds).toHaveLength(2);
    const [without, withTool] = status!.runIds as [string, string];
    for (const [runId, mode] of [[without, "without_tool"], [withTool, "with_tool"]] as const) {
      const report = JSON.parse(readFileSync(join(runsRoot, runId, "report.json"), "utf8"));
      expect(report.offlineDemo).toBe(true);
      expect(report.coverage).toMatchObject({ "exec:completed": 6, "grade:pending_human_review": 1 });
      expect(report.totals).toEqual({ confirmedRaw: 5, confirmedMax: 5, plannedMax: 9 });
      expect(report.toolVersions).toEqual([mode === "with_tool" ? EXAM_TOOLS_VERSION : "v1"]);
      const markdown = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
      expect(markdown).toContain("脚本作答与模拟用量");
      if (mode === "with_tool") {
        expect(markdown).toContain("v2-restricted（受限计算、附件与图像工具）");
        expect(markdown).toContain("不同工具版本能力不同，成绩不直接比较");
      } else {
        expect(markdown).toContain("v1（无工具）");
        expect(markdown).not.toContain("任意代码");
      }
    }
    const withToolDetail = await service.getValidatedTaskDetail(runsRoot, withTool, join(datasetsRoot, "demo"), "demo", "with_tool");
    expect(withToolDetail.questions.find((q) => q.questionId === "demo-physics")).toMatchObject({
      finalAnswerSheet: expect.stringContaining("计算工具计算"),
      metrics: { toolCalls: 1, toolErrors: 0 },
    });

    await command("results", "report");
    expect(render()).toContain("演示成绩");
    const result = screen();
    if (result.kind !== "report") throw new Error("未打开报告。");
    expect(result.mode).toBe("with_tool");
    expect(render()).toContain("v2-restricted（受限计算、附件与图像工具）");
    expect(render()).toContain("不同工具版本能力不同，成绩不直接比较");
    key("m");
    await vi.waitFor(() => expect(screen()).toMatchObject({ kind: "report", mode: result.mode === "with_tool" ? "without_tool" : "with_tool" }));
    await command("review", "review");
    expect(render()).toContain("demo-sequence");
    key("2"); key("\x1b[B"); render();
    for (const [field, value] of [["s", "4"], ["c", "演示复核"], ["e", "两小问计算过程与结果均正确"]]) {
      key(field!); type(value!); enter();
    }
    enter();
    await vi.waitFor(() => expect(screen()).toMatchObject({ kind: "review", confirming: true }));
    key("y");
    await vi.waitFor(() => expect(screen()).toMatchObject({ kind: "review", items: [] }));

    await command("tasks", "tasks");
    expect(render()).toContain("without_tool");
    expect(render()).toContain("with_tool");
    enter(); await waitForScreen("detail");
    key("v"); await waitForScreen("confirm");
    expect(screen()).toMatchObject({ resume: { queued: 0, retained: 6, blocked: 0 } });
    enter(); await waitForScreen("run");
    const resumed = await service.whenDone(tui.getState().taskId!);
    expect(resumed?.state, resumed?.error).toBe("done");
    expect(resumed?.telemetry?.reused).toBe(6);
    expect(resumed?.telemetry?.summary.requests).toBe(0);
    key("s");
    expect(render()).not.toContain("已请求停止");
  } finally {
    await tui.stopAndWait();
    app.dispose();
    vi.restoreAllMocks();
  }
}, 30000);
