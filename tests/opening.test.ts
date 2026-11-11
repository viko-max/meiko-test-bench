import { describe, expect, it } from "vitest";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderWordmark } from "../src/tui/wordmark.js";
import { openingBeat, OPENING_DURATION_MS } from "../src/tui/opening.js";

describe("品牌字标和开场时间线", () => {
  it("字标在不同列宽使用横排、两行和窄窗口文字，输出不溢出", () => {
    for (const width of [128, 91, 67, 57, 53, 40, 37, 35, 24, 8]) {
      const brand = renderWordmark(width);
      expect(brand.text).toBe("Meiko Test-Bench");
      expect(brand.width).toBeLessThanOrEqual(width);
      for (const line of brand.lines) expect(visibleWidth(line)).toBe(brand.width);
      if (width >= 37) expect(brand.lines.length).toBeGreaterThan(1);
    }
    expect(renderWordmark(91).lines).toHaveLength(4);
    expect(renderWordmark(57).lines).toHaveLength(8);
  });

  it("标题逐列出现；其间尺寸稳定，背景不形成白色矩形", () => {
    const hidden = renderWordmark(53, 0);
    const middle = renderWordmark(53, 0.5);
    const full = renderWordmark(53);
    expect(hidden.lines.map(stripTerminalSequences).join("").trim()).toBe("");
    expect(middle.lines).toHaveLength(full.lines.length);
    expect(middle.pixels.join("")).not.toBe(full.pixels.join(""));
    expect(full.lines[0]).toContain("38;2;111;211;204m");
    expect(full.lines.every((line) => !line.includes("48;2;"))).toBe(true);
  });

  it("橙色入场滑入、眨眼与摆尾后回到首页待机姿势", () => {
    expect(openingBeat(0).frame).toBe("idle");
    expect(openingBeat(600).frame).toBe("tailMid");
    expect(openingBeat(750).frame).toBe("blink");
    expect(openingBeat(925).frame).toBe("tailUp");
    expect(openingBeat(0).walk).toBe(0);
    expect(openingBeat(350).walk).toBe(1);
    expect(openingBeat(350).reveal).toBe(0);
    expect(openingBeat(1000).reveal).toBe(1);
    expect(openingBeat(1550).settle).toBeGreaterThan(0);
    expect(openingBeat(OPENING_DURATION_MS).settle).toBe(1);
    expect(openingBeat(OPENING_DURATION_MS).frame).toBe("idle");
  });
});
