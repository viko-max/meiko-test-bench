import { afterEach, describe, expect, it, vi } from "vitest";
import { ExamApp } from "../src/tui/app.js";
import { ExamTui } from "../src/tui/controller.js";
import { stopExamTerminal } from "../src/tui/terminal-lifecycle.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const tui = new ExamTui({ datasetsRoot: "unused", modelsConfigPath: "unused", runsRoot: "unused", workRoot: "unused", toolsVersion: "v1", pythonInterpreter: "python", animation: false });
  const app = new ExamApp(tui);
  app.rerender = vi.fn();
  return { tui, app };
}
async function flush() { await new Promise<void>((done) => setImmediate(done)); }

describe("终端退出生命周期", () => {
  it("等待任务存档和异步终端关闭；重复退出不重复执行清理", async () => {
    const { tui, app } = fixture();
    let archived!: () => void;
    let closed!: () => void;
    const stop = vi.spyOn(tui, "stopAndWait").mockImplementation(() => new Promise<void>((done) => { archived = done; }));
    const close = vi.fn(() => new Promise<void>((done) => { closed = done; }));
    app.setQuitHandler(close);
    try {
      app.handleInput("q"); await flush();
      app.handleInput("q");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
      archived(); await flush();
      expect(close).toHaveBeenCalledTimes(1);
      app.handleInput("q"); await flush();
      expect(close).toHaveBeenCalledTimes(1);
      closed(); await flush();
      expect(tui.getState().message).toBeUndefined();
    } finally { app.dispose(); }
  });

  it("异步关闭失败可见且可以重新退出，不产生未处理的拒绝", async () => {
    const { tui, app } = fixture();
    const close = vi.fn().mockRejectedValueOnce(new Error("终端恢复失败")).mockResolvedValueOnce(undefined);
    app.setQuitHandler(close);
    try {
      app.handleInput("\x03"); await flush();
      expect(tui.getState().message).toContain("退出失败：终端恢复失败");
      expect(app.rerender).toHaveBeenCalled();
      app.handleInput("\x03"); await flush();
      expect(close).toHaveBeenCalledTimes(2);
    } finally { app.dispose(); }
  });

  it("任务停止失败不会提前关闭终端，错误可见且允许重试", async () => {
    const { tui, app } = fixture();
    vi.spyOn(tui, "stopAndWait").mockRejectedValueOnce(new Error("测试存档失败")).mockResolvedValueOnce();
    const close = vi.fn(); app.setQuitHandler(close);
    try {
      app.handleInput("q"); await flush();
      expect(close).not.toHaveBeenCalled();
      expect(tui.getState().message).toContain("测试存档失败");
      app.handleInput("q"); await flush();
      expect(close).toHaveBeenCalledTimes(1);
    } finally { app.dispose(); }
  });

  it("非 TTY 不暂停输入；停止异常保持可观察", async () => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    const pause = vi.spyOn(process.stdin, "pause");
    const stop = vi.fn(() => { throw new Error("停止失败"); });
    try {
      await expect(stopExamTerminal({ stop })).rejects.toThrow("停止失败");
      expect(pause).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });
});
