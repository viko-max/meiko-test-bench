import { beforeAll, describe, expect, it, vi } from "vitest";
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { MASCOT_COLORWAYS, prepareMascotImage, rasterizeMascot, renderMascotDisplay, renderMascotImage, TERMINAL_BACKGROUND } from "../src/tui/mascot.js";
import { mascotStatus, runtimeStatusLine } from "../src/tui/mascot-status.js";
import { renderWordmark } from "../src/tui/wordmark.js";
import { summarizeRequests } from "../src/shared/metrics.js";
import type { TaskStatus } from "../src/service/task-service.js";
import { ExamApp } from "../src/tui/app.js";
import { ExamTui } from "../src/tui/controller.js";

beforeAll(() => prepareMascotImage(), 20000);

function status(states: string[], state: TaskStatus["state"] = "running"): TaskStatus {
  return {
    taskId: "offline", state, runIds: [], events: [],
    telemetry: {
      runId: "offline", mode: "with_tool", provider: "faux", modelId: "faux", concurrency: 2, apiConcurrency: 2,
      elapsedMs: 0, summary: summarizeRequests([]), processed: 0, reused: 0, toolCalls: 0, toolErrors: 0, activeRequests: 0,
      questions: states.map((phase, index) => ({ questionId: `q${index}`, state: phase, requests: [], toolCalls: 0, toolErrors: 0, reused: false, summary: summarizeRequests([]) })),
    },
  };
}

describe("胸像和真实状态展示", () => {
  it("胸像与旧全身稿分开缓存，三种发色保持透明背景和蓝色服装", () => {
    const variants = MASCOT_COLORWAYS.map((colorway) => {
      const portrait = rasterizeMascot(80, 40, undefined, "idle", colorway, "portrait");
      expect(portrait.data.equals(rasterizeMascot(80, 40, undefined, "idle", colorway).data)).toBe(false);
      expect([...portrait.data.subarray(0, 3)]).toEqual(TERMINAL_BACKGROUND);
      let blue = 0;
      for (let i = 0; i < portrait.data.length; i += 3) {
        if (portrait.data[i + 2]! > portrait.data[i]! + 25 && portrait.data[i + 2]! > portrait.data[i + 1]! + 15) blue++;
      }
      expect(blue).toBeGreaterThan(80 * 80 * 0.08);
      return portrait.data.toString("base64");
    });
    expect(new Set(variants).size).toBe(3);
  });

  it("胸像不接受旧动作帧，不会从胸像切回其他姿势", () => {
    expect(() => renderMascotImage(48, 24, undefined, "blink", "orange", "portrait")).toThrow("idle");
  });

  it("普通终端和 Kitty 都使用胸像，窄头像和大首页均保持占位尺寸", () => {
    const original = getCapabilities();
    try {
      for (const images of [null, "kitty"] as const) {
        setCapabilities({ ...original, images });
        for (const size of [24, 32, 48, 64, 80]) {
          const lines = renderMascotDisplay(size, size / 2, "idle", "orange", "portrait");
          expect(lines).toHaveLength(size / 2);
          expect(lines.every((line) => visibleWidth(line) === size)).toBe(true);
          expect(lines.join("")).toContain(images === "kitty" ? "\x1b_G" : "▀");
        }
      }
    } finally { setCapabilities(original); }
  });

  it("并发推理和工具执行分别计数，排队题目不会显示为正在推理", () => {
    expect(mascotStatus(status(["tool", "reasoning", "reasoning", "queued"])))
      .toEqual({ label: "并发作答", detail: "工具 1 · 推理 2", tone: "active" });
    expect(mascotStatus(status(["queued"])).label).toBe("准备请求");
    expect(mascotStatus().label).toBe("待命");
    expect(mascotStatus(status(["waiting"])).label).toBe("等待中");
  });

  it("运行页收起装饰后仍显示并发阶段计数", () => {
    const tui = new ExamTui({ datasetsRoot: ".work/mascot-layout-20261029/datasets", runsRoot: ".work/mascot-layout-20261029/runs", workRoot: ".work/mascot-layout-20261029/work", modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python", animation: false });
    vi.spyOn(tui, "getState").mockReturnValue({ ...tui.getState(), screen: { kind: "run", taskId: "offline" } });
    // 服务状态用于构造确定的并发边界；渲染和统计使用生产实现，不启动答题。
    vi.spyOn(tui.getService(), "getStatus").mockReturnValue(status(["tool", "reasoning", "reasoning", "queued"]));
    const app = new ExamApp(tui);
    vi.spyOn(app as any, "termRows").mockReturnValue(40);
    try {
      for (const width of [80, 136]) {
        const lines = app.render(width);
        const plain = lines.map(stripTerminalSequences);
        expect(plain[0]).toContain("并发作答");
        expect(plain[1]).toContain("工具 1 · 推理 2");
        expect(plain.join("\n")).not.toMatch(/▀{24}/);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    } finally { app.dispose(); vi.restoreAllMocks(); }
  });

  it.each(["error", "stopped", "budget_paused"] as const)("%s 优先于残留的推理事件", (state) => {
    expect(mascotStatus(status(["reasoning"], state)).tone).toBe(state === "error" ? "error" : "warning");
  });

  it("结束时存在未知结果或截断，不显示为全部完成", () => {
    expect(mascotStatus(status(["completed", "outcome_unknown"], "done"))).toEqual({ label: "已结束", detail: "异常 1 题", tone: "warning" });
    const truncated = status(["completed"], "done");
    truncated.telemetry!.questions[0]!.terminationCause = "output_token_limit";
    expect(mascotStatus(truncated).tone).toBe("warning");
    expect(mascotStatus(status(["completed"], "done")).tone).toBe("success");
    expect(mascotStatus({ taskId: "offline", state: "done", runIds: [], events: [] }).label).toBe("已结束");
  });

  it("底部指标不把未知用量和 TPS 显示为零，部分用量保留标记", () => {
    const metrics = summarizeRequests([]);
    expect(runtimeStatusLine(metrics, null)).toBe("TPS(含等待) 未提供 · 缓存 未提供 · 所选题推理请求 未记录 · Token 未提供");
    metrics.requestTps = 36.2;
    metrics.cacheHitRate = 0.47;
    metrics.tokens.totalTokens = { value: 1234, known: 1, total: 2 };
    expect(runtimeStatusLine(metrics, "high")).toBe("TPS(含等待) 36.2 · 缓存 47.0% · 所选题推理请求 high · Token 1234（部分已知）");
    expect(runtimeStatusLine(metrics)).not.toContain("推理请求");
  });

  it("主字标等比放大，动画揭示前后尺寸稳定", () => {
    const regular = renderWordmark(64);
    const prominent = renderWordmark(64, 1, true);
    expect(prominent.width).toBe(58);
    expect(prominent.lines.length).toBeGreaterThan(regular.lines.length);
    expect(prominent.lines.length).toBe(renderWordmark(64, 0.5, true).lines.length);
    expect(prominent.lines.every((line) => visibleWidth(line) === prominent.width)).toBe(true);
    for (let row = 0; row < 14; row += 2) {
      expect(prominent.pixels[row]).toBe(prominent.pixels[row + 1]);
      for (let column = 0; column < 58; column += 2) expect(prominent.pixels[row]![column]).toBe(prominent.pixels[row]![column + 1]);
    }
  });
});
