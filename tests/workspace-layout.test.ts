import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { prepareMascotImage, renderMascotImage } from "../src/tui/mascot.js";

beforeAll(() => prepareMascotImage(), 20000);

describe("功能页共享布局", () => {
  it.each(["bank", "tasks", "settings"] as const)("%s 收起候选项释放正文空间，展开仍在输入栏下方", async (page) => {
    mkdirSync(resolve(".work"), { recursive: true });
    const root = mkdtempSync(resolve(".work", "workspace-layout-"));
    const tui = new ExamTui({ datasetsRoot: join(root, "datasets"), runsRoot: join(root, "runs"), workRoot: join(root, "work"), modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python", animation: false });
    const app = new ExamApp(tui);
    let height = 28;
    vi.spyOn(app as any, "termRows").mockImplementation(() => height);
    try {
      await tui.gotoHome();
      if (page === "bank") tui.gotoBank();
      else if (page === "tasks") await tui.openTasks();
      else tui.gotoSettings();
      for (const [width, rows, size] of [[160, 50, 64], [136, 40, 48], [136, 28, 0], [80, 24, 0]]) {
        height = rows!;
        const before = app.render(width!);
        const input = before.map(stripTerminalSequences).findIndex((line) => line.includes("输入消息，或 / 查看命令"));
        expect(input).toBeGreaterThanOrEqual(height - 4);
        const colorway = page === "bank" ? "pink" : page === "tasks" ? "black" : "orange";
        if (size) expect(before.join("\n")).toContain(renderMascotImage(size, size / 2, undefined, "idle", colorway, "entrance")[5]);
        else expect(before.join("\n")).not.toContain("▀".repeat(24));
        app.handleInput("/");
        const opened = app.render(width!);
        const plain = opened.map(stripTerminalSequences);
        const openedInput = plain.findIndex((line) => line.includes("› /"));
        expect(openedInput).toBe(input - 5);
        expect(plain.findIndex((line) => line.includes("/run"))).toBeGreaterThan(openedInput);
        expect(opened).toHaveLength(height);
        expect(opened.every((line) => visibleWidth(line) <= width!)).toBe(true);
        if (size) for (let row = 2; row < 2 + size / 2; row++) expect(sliceByColumn(opened[row]!, 2, size)).toBe(sliceByColumn(before[row]!, 2, size));
        app.handleInput("\x1b");
        expect(app.render(width!)).toEqual(before);
      }
    } finally { app.dispose(); }
  });
});
