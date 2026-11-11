import { describe, expect, it, vi } from "vitest";
import { CommandBar } from "../src/tui/command-bar.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

describe("斜杠命令输入", () => {
  it("输入前缀筛选，方向键选择，Tab 补全后 Enter 只执行一次", () => {
    const bar = new CommandBar();
    bar.onExecute = vi.fn();
    bar.open("/r");
    expect(bar.render(80).join("\n")).toContain("/review");
    bar.handleInput("\x1b[B");
    bar.handleInput("\t");
    expect(bar.value).toBe("/results");
    bar.handleInput("\r");
    expect(bar.onExecute).toHaveBeenCalledTimes(1);
    expect(bar.onExecute).toHaveBeenCalledWith("results");
    expect(bar.active).toBe(false);
  });

  it("未知命令与参数显示错误，不执行任何操作", () => {
    const bar = new CommandBar();
    bar.onExecute = vi.fn();
    for (const value of ["/unknown", "/run --paid", "普通文本"]) {
      bar.open(value);
      bar.handleInput("\r");
      expect(bar.render(60).join("\n")).toContain("无法识别命令");
    }
    expect(bar.onExecute).not.toHaveBeenCalled();
  });

  it("长列表向下滚动可选中 quit，Esc 清除输入但不执行", () => {
    const bar = new CommandBar();
    bar.onExecute = vi.fn();
    bar.open();
    for (let i = 0; i < 30; i++) bar.handleInput("\x1b[B");
    const lines = bar.render(80, 3);
    expect(lines.join("\n")).toContain("/quit");
    expect(lines).toHaveLength(6);
    bar.handleInput("\x1b");
    expect(bar.active).toBe(false);
    expect(bar.value).toBe("");
    expect(bar.onExecute).not.toHaveBeenCalled();
  });

  it("粘贴完整命令不会把 q 当作退出快捷键，点击执行真实建议", () => {
    const bar = new CommandBar();
    bar.onExecute = vi.fn();
    bar.open("");
    bar.handleInput("\x1b[200~/quit\x1b[201~");
    expect(bar.value).toBe("/quit");
    expect(bar.onExecute).not.toHaveBeenCalled();
    const lines = bar.render(40);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    expect(bar.handleMouse({ type: "click", button: "left", x: 4, y: 3 } as Parameters<CommandBar["handleMouse"]>[0])).toEqual({ handled: true });
    expect(bar.onExecute).toHaveBeenCalledTimes(1);
    expect(bar.onExecute).toHaveBeenCalledWith("quit");
  });

  it("输入栏上方没有候选项，向下展开且筛选、收起、报错都保持高度", () => {
    const bar = new CommandBar();
    const closed = bar.render(70, 5).map(stripTerminalSequences);
    bar.open();
    const opened = bar.render(70, 5).map(stripTerminalSequences);
    expect(opened[1]).toContain("/");
    expect(opened[3]).toContain("/run");
    expect(opened.slice(0, 3).join("\n")).not.toContain("/run");
    expect(opened).toHaveLength(closed.length);
    bar.open("/quit");
    expect(bar.render(70, 5)).toHaveLength(closed.length);
    bar.open("/unknown");
    bar.handleInput("\r");
    expect(bar.render(70, 5)).toHaveLength(closed.length);
    bar.close();
    const clicked = bar.handleMouse({ type: "click", button: "left", x: 4, y: 3 } as Parameters<CommandBar["handleMouse"]>[0]);
    expect(clicked).toBeUndefined();
    expect(bar.render(70, 5)).toHaveLength(closed.length);
  });
});
