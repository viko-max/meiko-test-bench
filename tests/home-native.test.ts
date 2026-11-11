import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { stripTerminalSequences, visibleWidth, sliceByColumn } from "@earendil-works/pi-tui";
import { prepareMascotImage, rasterizeMascot, renderMascotImage } from "../src/tui/mascot.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { OPENING_DURATION_MS } from "../src/tui/opening.js";

beforeAll(() => prepareMascotImage(), 20000);

describe("首页原生像素与命令区", () => {
  it.each([48, 64])("%s 定稿使用有限色板透明 PNG", async (size) => {
    const file = `src/tui/meiko-home-${size}-v3.png`;
    const metadata = await sharp(file).metadata();
    expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([size, size, true]);
    const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const colors = new Set<string>();
    for (let offset = 0; offset < data.length; offset += 4) {
      colors.add(data.subarray(offset, offset + 4).toString("hex"));
      expect([0, 255]).toContain(data[offset + 3]);
    }
    expect(colors.size).toBeLessThanOrEqual(20);
  });

  it("64 定稿完整展示，保留头饰、头发和肩部的每个像素", async () => {
    const full = rasterizeMascot(64, 32, undefined, "idle", "orange", "home");
    const expected = await sharp("src/tui/meiko-home-64-v3.png").flatten({ background: "#002a32" }).removeAlpha().raw().toBuffer();
    expect(full.data.equals(expected)).toBe(true);
  });

  it("48 定稿完整展示，渲染不再次缩放或裁切人物", async () => {
    const expected = await sharp("src/tui/meiko-home-48-v3.png").flatten({ background: "#002a32" }).removeAlpha().raw().toBuffer();
    expect(rasterizeMascot(48, 24, undefined, "idle", "orange", "home").data.equals(expected)).toBe(true);
  });

  it("拒绝任意比例缩放以及未制作的动作和配色", () => {
    for (const size of [24, 32]) expect(() => rasterizeMascot(size, size / 2, undefined, "idle", "orange", "home")).toThrow("完整的 48/64");
    expect(() => rasterizeMascot(80, 40, undefined, "idle", "orange", "home")).toThrow("原生网格");
    expect(() => rasterizeMascot(64, 32, undefined, "blink", "orange", "home")).toThrow("idle");
    expect(() => rasterizeMascot(64, 32, undefined, "idle", "pink", "home")).toThrow("橙色");
  });

  it.each([[160, 50, 64], [136, 40, 64], [136, 28, 48], [80, 24, 0]])("%s×%s 收起菜单不留空白槽位，展开保持完整角色和标题", async (width, height, size) => {
    mkdirSync(resolve(".work"), { recursive: true });
    const root = mkdtempSync(resolve(".work", "home-native-"));
    const tui = new ExamTui({ datasetsRoot: join(root, "datasets"), runsRoot: join(root, "runs"), workRoot: join(root, "work"), modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python", animation: false });
    const app = new ExamApp(tui);
    vi.spyOn(app as any, "termRows").mockReturnValue(height);
    try {
      await tui.gotoHome();
      const before = app.render(width);
      const input = before.map(stripTerminalSequences).findIndex((line) => line.includes("输入消息，或 / 查看命令"));
      expect(input).toBe(height - 3);
      const reference = size ? renderMascotImage(size, size / 2, undefined, "idle", "orange", "entrance")[5]! : "";
      const artRow = size ? before.findIndex((line) => line.includes(reference)) : -1;
      const art = artRow < 0 ? undefined : { y: artRow - 5 };
      if (size) expect(art).toBeDefined();
      else expect(before.join("\n")).not.toMatch(/▀{24}/);
      const x = art ? visibleWidth(before[artRow]!.slice(0, before[artRow]!.indexOf(reference))) : 0;
      app.handleInput("/");
      const expanded = app.render(width);
      const plain = expanded.map(stripTerminalSequences);
      const newInput = plain.findIndex((line) => line.includes("› /"));
      expect(newInput).toBe(input - 5);
      expect(plain.findIndex((line) => line.includes("/run"))).toBeGreaterThan(newInput);
      if (art) for (let y = 0; y < size / 2; y++) expect(sliceByColumn(expanded[art.y + y]!, x, size)).toBe(sliceByColumn(before[art.y + y]!, x, size));
      const title = (lines: string[]) => lines.flatMap((line, y) => {
        const start = line.indexOf("\x1b[0m\x1b[38;2;111;211;204m");
        return start < 0 ? [] : [{ y, x: visibleWidth(line.slice(0, start)), value: stripTerminalSequences(line.slice(start)) }];
      });
      expect(title(expanded)).toEqual(title(before));
      expect(expanded.every((line) => visibleWidth(line) <= width)).toBe(true);
      app.handleInput("\x1b");
      expect(app.render(width)).toEqual(before);
      tui.toggleAnimation();
      await tui.begin();
      (app as unknown as { openingElapsed: number }).openingElapsed = OPENING_DURATION_MS;
      const lastOpening = app.render(width);
      expect(title(lastOpening)).toEqual(title(before));
      if (art) for (let y = 0; y < size / 2; y++) expect(sliceByColumn(lastOpening[art.y + y]!, x, size)).toBe(sliceByColumn(before[art.y + y]!, x, size));
    } finally { app.dispose(); }
  });
});
