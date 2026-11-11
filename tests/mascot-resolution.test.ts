import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { getCapabilities, setCapabilities, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { prepareMascotImage, rasterizeMascot, renderMascotDisplay, renderMascotImage, MASCOT_COLORWAYS } from "../src/tui/mascot.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { OPENING_DURATION_MS } from "../src/tui/opening.js";

beforeAll(() => prepareMascotImage(), 20000);
function fixture() {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "mascot-resolution-"));
  const tui = new ExamTui({ datasetsRoot: join(root, "datasets"), runsRoot: join(root, "runs"), workRoot: join(root, "work"), modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python" });
  return { tui, app: new ExamApp(tui) };
}
describe("原稿分辨率与页面一致性", () => {
  it("入场帧保留 640 像素源图，两档色块都能区分动作，Kitty 待机缓存可复用", async () => {
    const caps = getCapabilities();
    try {
      for (const [color, pose, frames] of [["orange", "blink", 5], ["pink", "waveOut", 3], ["black", "nod", 3]] as const) {
        const meta = await sharp(`src/tui/meiko-entrance-${color}.png`).metadata();
        expect([meta.width, meta.height, meta.hasAlpha]).toEqual([frames * 640, 640, true]);
        for (const size of [48, 64]) {
          const idle = rasterizeMascot(size, size / 2, undefined, "idle", color, "entrance");
          const action = rasterizeMascot(size, size / 2, undefined, pose, color, "entrance");
          expect(idle.alpha[0]).toBe(0);
          expect(action.data.equals(idle.data)).toBe(false);
        }
        setCapabilities({ ...caps, images: "kitty" });
        const idle = renderMascotDisplay(64, 32, "idle", color, "entrance");
        const action = renderMascotDisplay(64, 32, pose, color, "entrance");
        const id = (lines: string[]) => /\bi=(\d+)(?=[,;])/.exec(lines[0]!)?.[1];
        expect(idle).toHaveLength(32);
        expect(id(idle)).toBeDefined();
        expect(id(action)).toBeDefined();
        expect(id(action)).not.toBe(id(idle));
        expect(renderMascotDisplay(64, 32, "idle", color, "entrance")).toEqual(idle);
      }
    } finally { setCapabilities(caps); }
  });
  it("64/80 网格直接取得额外细节，不能只是把 48 网格复制放大", () => {
    for (const colorway of MASCOT_COLORWAYS) {
      const small = rasterizeMascot(48, 24, undefined, "idle", colorway);
      for (const size of [64, 80]) {
        const actual = rasterizeMascot(size, size / 2, undefined, "idle", colorway);
        const enlarged = Buffer.alloc(actual.data.length);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const offset = (Math.floor(y * 48 / size) * 48 + Math.floor(x * 48 / size)) * 3;
          enlarged.set(small.data.subarray(offset, offset + 3), (y * size + x) * 3);
        }
        expect(actual.data.equals(enlarged)).toBe(false);
        expect(renderMascotImage(size, size / 2, undefined, "idle", colorway).every((line) => visibleWidth(line) === size)).toBe(true);
      }
    }
  });

  it("大窗口保留 64 原生网格；命令下展不会改变角色；开场最终位置逐像素相同", async () => {
    const s = fixture(); const caps = getCapabilities(); const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      setCapabilities({ images: null, trueColor: true, hyperlinks: true });
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 50 });
      await s.tui.begin();
      // 推进生产时间线后比较实际页面；不改变动作素材或伪造角色内容。
      (s.app as unknown as { openingElapsed: number }).openingElapsed = OPENING_DURATION_MS;
      const opening = s.app.render(160);
      await s.tui.gotoHome(); const home = s.app.render(160);
      const art = renderMascotImage(64, 32, undefined, "idle", "orange", "entrance");
      const referenceRow = home.findIndex((line) => line.includes(art[5]!));
      expect(referenceRow).toBeGreaterThanOrEqual(5);
      const location = { y: referenceRow - 5 };
      const x = visibleWidth(home[referenceRow]!.slice(0, home[referenceRow]!.indexOf(art[5]!)));
      for (let y = 0; y < 32; y++) {
        expect(sliceByColumn(home[location.y + y]!, x, 64)).toBe(sliceByColumn(opening[location.y + y]!, x, 64));
        expect(visibleWidth(sliceByColumn(home[location.y + y]!, x, 64))).toBe(64);
        expect(sliceByColumn(home[location.y + y]!, x, 64)).toBe(sliceByColumn(art[y]!, 0, 64));
      }
      expect(art).toHaveLength(32);
      s.app.handleInput("/"); const expanded = s.app.render(160);
      for (let y = 0; y < 32; y++) expect(sliceByColumn(expanded[location.y + y]!, x, 64)).toBe(sliceByColumn(home[location.y + y]!, x, 64));
      const text = expanded.map(stripTerminalSequences); const input = text.findIndex((line) => line.includes("› /"));
      expect(text.findIndex((line) => line.includes("/run"))).toBeGreaterThan(input);
      expect(expanded.every((line) => visibleWidth(line) <= 160)).toBe(true);
    } finally { s.app.dispose(); setCapabilities(caps); if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows"); }
  });
});
