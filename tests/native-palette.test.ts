import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { getCapabilities, setCapabilities, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { nativePalette } from "../src/tui/native-palette.js";
import { MASCOT_COLORWAYS, prepareMascotImage, rasterizeMascot, renderMascotDisplay, renderMascotImage } from "../src/tui/mascot.js";

beforeAll(() => prepareMascotImage(), 20000);

describe("共用母稿的终端配色", () => {
  it.each([48, 64])("%s 配色只改变颜色，原始数据和 Alpha 保持不变", async (size) => {
    const original = await sharp(`src/tui/meiko-home-${size}-v3.png`).ensureAlpha().raw().toBuffer();
    const backup = Buffer.from(original);
    const variants = MASCOT_COLORWAYS.map((colorway) => nativePalette(original, size, size, colorway));
    expect(original.equals(backup)).toBe(true);
    expect(variants[0]!.equals(original)).toBe(true);
    expect(new Set(variants.map((data) => data.toString("base64"))).size).toBe(3);
    for (const data of variants) {
      for (let offset = 0; offset < original.length; offset += 4) {
        expect(data[offset + 3]).toBe(original[offset + 3]);
        const [r, g, b] = original.subarray(offset, offset + 3);
        // 蓝色衣服、白色头饰、金色配件不随发色变化。
        if (b! > r! + 25 || r! > 230 && g! > 230 && b! > 210 || r! > 230 && g! > 160 && b! < 50) {
          expect(data.subarray(offset, offset + 4).equals(original.subarray(offset, offset + 4))).toBe(true);
        }
      }
    }
  });

  it("橙色眼睛和嘴保持原色，头发和花瓣确实切换", async () => {
    const original = await sharp("src/tui/meiko-home-64-v3.png").ensureAlpha().raw().toBuffer();
    for (const colorway of ["pink", "black"] as const) {
      const result = nativePalette(original, 64, 64, colorway);
      for (const [x, y] of [[24, 40], [26, 42], [39, 40], [41, 42], [32, 46], [33, 46]]) {
        const offset = (y! * 64 + x!) * 4;
        expect(result.subarray(offset, offset + 4).equals(original.subarray(offset, offset + 4))).toBe(true);
      }
      for (const [x, y] of [[18, 5], [30, 24], [51, 22]]) {
        const offset = (y! * 64 + x!) * 4;
        expect(result.subarray(offset, offset + 4).equals(original.subarray(offset, offset + 4))).toBe(false);
      }
    }
  });

  it.each(MASCOT_COLORWAYS)("%s 完整保留母稿，Kitty 和普通终端占位一致", async (colorway) => {
    for (const size of [48, 64]) {
      const original = await sharp(`src/tui/meiko-home-${size}-v3.png`).ensureAlpha().raw().toBuffer();
      const expected = await sharp(nativePalette(original, size, size, colorway), { raw: { width: size, height: size, channels: 4 } })
        .flatten({ background: "#002a32" }).removeAlpha().raw().toBuffer();
      const full = rasterizeMascot(size, size / 2, undefined, "idle", colorway, "native");
      expect(full.data.equals(expected)).toBe(true);
    }
    const caps = getCapabilities();
    try {
      for (const images of [null, "kitty"] as const) {
        setCapabilities({ ...caps, images });
        for (const size of [48, 64]) {
          const lines = renderMascotDisplay(size, size / 2, "idle", colorway, "native");
          expect(lines).toHaveLength(size / 2);
          expect(lines.every((line) => visibleWidth(line) === size)).toBe(true);
          expect(lines.join("")).toContain(images === "kitty" ? "\x1b_G" : "▀");
        }
      }
    } finally { setCapabilities(caps); }
  });

  it("无效画布、未制作动作和任意比例缩放明确拒绝", () => {
    expect(() => nativePalette(Buffer.alloc(8), 64, 64, "pink")).toThrow("RGBA");
    expect(() => nativePalette(Buffer.alloc(64 * 64 * 4), 64, 64, "pink")).toThrow("色板已变化");
    for (const size of [24, 32]) expect(() => rasterizeMascot(size, size / 2, undefined, "idle", "pink", "native")).toThrow("完整的 48/64");
    expect(() => rasterizeMascot(80, 40, undefined, "idle", "pink", "native")).toThrow("原生角色");
    expect(() => rasterizeMascot(32, 16, undefined, "blink", "black", "native")).toThrow("idle");
  });

  it.each(MASCOT_COLORWAYS)("%s 透明边角继承终端背景，不绘制固定底色的画框", (colorway) => {
    const lines = renderMascotImage(64, 32, undefined, "idle", colorway, "native");
    const corner = sliceByColumn(lines[0]!, 0, 1);
    expect(stripTerminalSequences(corner)).toBe(" ");
    expect(corner).not.toContain("48;2;");
    // 边缘仅下半格有色时，上半格保留默认背景。
    expect(lines.some((line) => /\x1b\[0m\x1b\[38;2;\d+;\d+;\d+m▄/.test(line))).toBe(true);
  });
});
