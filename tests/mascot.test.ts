import { describe, it, expect } from "vitest";
import { MASCOT_W, MASCOT_H, COMPACT_MASCOT_W, COMPACT_MASCOT_H, normalize, renderMascot, idleFrame, blinkFrame, waveFrame, TERMINAL_BACKGROUND, prepareMascotImage, renderMascotImage } from "../src/tui/mascot.js";
import { rasterizeMascot, renderMascotDisplay } from "../src/tui/mascot.js";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { ACTION_FRAMES, MASCOT_COLORWAYS } from "../src/tui/mascot.js";

const halfCount = (line: string): number => (line.match(/▀/g) ?? []).length;

describe("mascot pixel engine", () => {
  it("normalizes any grid to the large 48×48 variant", () => {
    const g = normalize(["oo", ".".repeat(40), ""]);
    expect(g).toHaveLength(MASCOT_H);
    for (const row of g) expect(row.length).toBe(MASCOT_W);
  });

  it("large idle/blink/wave frames have a stable 48×48 canvas", () => {
    for (const f of [idleFrame(), blinkFrame(), waveFrame()]) {
      expect(f).toHaveLength(MASCOT_H);
      for (const row of f) expect(row.length).toBe(MASCOT_W);
    }
  });

  it("renders the large mascot as 24 half-block rows by 48 terminal cells", () => {
    const lines = renderMascot(idleFrame());
    expect(lines).toHaveLength(MASCOT_H / 2);
    for (const l of lines) expect(halfCount(l)).toBe(MASCOT_W);
    expect(lines[0]).toContain("\x1b[38;2;"); // truecolor fg
    expect(lines[0]).toContain("\x1b[48;2;"); // truecolor bg
  });

  it("uses the mascot palette (orange hair + dark-blue dress present)", () => {
    const out = renderMascot(idleFrame()).join("");
    expect(out).toContain("38;2;242;104;37"); // hair orange
    expect(out).toContain("48;2;44;70;136"); // dress blue (as a bg half)
    expect(out).toContain(`48;2;${TERMINAL_BACKGROUND.join(";")}m`); // transparent cells use the app background
  });

  it("blink and wave differ from idle", () => {
    expect(blinkFrame().join()).not.toBe(idleFrame().join());
    expect(waveFrame().join()).not.toBe(idleFrame().join());
  });

  it("uses a 32×32 rendition of the same pixel mascot for smaller terminals", () => {
    const small = idleFrame(true);
    expect(small).toHaveLength(COMPACT_MASCOT_H);
    for (const row of small) expect(row.length).toBe(COMPACT_MASCOT_W);
    const lines = renderMascot(small);
    expect(lines).toHaveLength(COMPACT_MASCOT_H / 2);
    for (const l of lines) expect(halfCount(l)).toBe(COMPACT_MASCOT_W);
    expect(small.join("\n")).toContain("w"); // 保留原稿中的白色头饰和围裙像素
    expect(small.join("\n")).toContain("Y"); // 保留原稿中的橙花与金色细节
  });

  it("renders the original mascot at terminal resolution with its source colors", async () => {
    await prepareMascotImage();
    const lines = renderMascotImage(60, 36);
    expect(lines).toHaveLength(36);
    for (const line of lines) expect(halfCount(line)).toBe(60);
    expect(lines.join(" ")).toContain("38;2;");
    expect(new Set(lines.join(" ").match(/38;2;\d+;\d+;\d+/g) ?? []).size).toBeGreaterThan(12);
  });

  it("透明角落保留自定义背景，色块渲染与预览读取同一份 RGB", async () => {
    await prepareMascotImage();
    const bg: [number, number, number] = [9, 18, 27];
    const pixels = rasterizeMascot(48, 24, bg);
    expect(Array.from(pixels.data.subarray(0, 3))).toEqual(bg);
    expect(renderMascotImage(48, 24, bg)[0]).toContain("38;2;9;18;27m");
    expect(pixels.data).toHaveLength(48 * 48 * 3);
    expect(() => renderMascotImage(0, 24)).toThrow("正整数");
  });

  it("两种尺寸各有六个真实动作帧；普通窗口不使用大稿缩小", async () => {
    await prepareMascotImage();
    for (const size of [32, 48]) {
      const frames = ACTION_FRAMES.map((frame) => rasterizeMascot(size, size / 2, TERMINAL_BACKGROUND, frame));
      expect(new Set(frames.map((frame) => frame.data.toString("base64"))).size).toBe(6);
      for (const frame of frames) {
        expect(frame.data).toHaveLength(size * size * 3);
        expect(Array.from(frame.data.subarray(0, 3))).toEqual(TERMINAL_BACKGROUND);
      }
    }
    const small = rasterizeMascot(32, 16).data;
    const large = rasterizeMascot(48, 24).data;
    const downsampled = Buffer.alloc(32 * 32 * 3);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const offset = (Math.floor(y * 48 / 32) * 48 + Math.floor(x * 48 / 32)) * 3;
      downsampled.set(large.subarray(offset, offset + 3), (y * 32 + x) * 3);
    }
    expect(small.equals(downsampled)).toBe(false);
  });

  it("Kitty 使用 PNG 且预留完整占位，iTerm2 替代屏使用色块", async () => {
    await prepareMascotImage();
    const original = getCapabilities();
    try {
      setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
      const native = renderMascotDisplay(48, 24);
      expect(native).toHaveLength(24);
      expect(native[0]).toContain("\x1b_G");
      for (const line of native) expect(visibleWidth(line)).toBe(48);
      const pink = renderMascotDisplay(48, 24, "idle", "pink");
      const black = renderMascotDisplay(48, 24, "idle", "black");
      expect(pink.join("\n")).not.toBe(native.join("\n"));
      expect(black.join("\n")).not.toBe(pink.join("\n"));
      expect(renderMascotDisplay(48, 24)).toEqual(native);
      setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
      expect(renderMascotDisplay(32, 16).join("\n")).toContain("▀");
    } finally { setCapabilities(original); }
  });

  it("三款配色均有透明背景、蓝色服装和独立帧缓存", async () => {
    await prepareMascotImage();
    for (const size of [32, 48]) {
      const variants = MASCOT_COLORWAYS.map((colorway) => rasterizeMascot(size, size / 2, undefined, "idle", colorway));
      expect(new Set(variants.map((variant) => variant.data.toString("base64"))).size).toBe(3);
      for (const colorway of MASCOT_COLORWAYS) {
        for (const frame of ACTION_FRAMES) {
          const raster = rasterizeMascot(size, size / 2, undefined, frame, colorway);
          expect(Array.from(raster.data.subarray(0, 3))).toEqual(TERMINAL_BACKGROUND);
          let blues = 0;
          for (let i = 0; i < raster.data.length; i += 3) {
            if (raster.data[i + 2]! > raster.data[i]! + 25 && raster.data[i + 2]! > raster.data[i + 1]! + 15) blues++;
          }
          expect(blues).toBeGreaterThan(size * size * 0.1);
          const lines = renderMascotImage(size, size / 2, undefined, frame, colorway);
          expect(lines).toHaveLength(size / 2);
          for (const line of lines) expect(visibleWidth(line)).toBe(size);
        }
      }
    }
  });
});
