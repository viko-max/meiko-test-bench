import { describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { coverageLines } from "../src/tui/metrics-view.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";

describe("成绩覆盖展示", () => {
  it("确认、初评、未知结果分别展示，保留零值和未知字段", () => {
    const coverage = { "exec:completed": 38, "exec:outcome_unknown": 2, "grade:rule_graded": 35, "grade:human_confirmed": 2,
      "grade:model_preliminary": 1, "grade:ungraded": 2, "exec:queued": 0, "exec:new_status": 3, future_field: 4 };
    const before = JSON.stringify(coverage);
    expect(coverageLines(coverage)).toEqual([
      "作答状态  已完成 38 · 结果未知 2 · 排队 0 · exec:new_status 3",
      "评分状态  规则确认 35 · 人工确认 2 · 模型初评 1 · 未评分 2",
      "其他覆盖  future_field 4",
    ]);
    expect(JSON.stringify(coverage)).toBe(before);
    expect(coverageLines({})).toEqual(["覆盖记录未提供"]);
  });

  it("80 列成绩页换行显示覆盖计数，不改变原始总分", () => {
    const tui = new ExamTui({ datasetsRoot: "unused", runsRoot: "unused", workRoot: ".work", modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python" });
    const coverage = { "exec:completed": 38, "exec:outcome_unknown": 2, "exec:interrupted": 1, "exec:limit_reached": 1,
      "exec:unsupported_input": 1, "exec:failed_unprocessed": 1, "grade:rule_graded": 35, "grade:human_confirmed": 2, "grade:pending_human_review": 3 };
    // 确定性页面材料验证多种状态同时出现时不会被一行 JSON 裁掉。
    tui.getState().screen = { kind: "report", runId: "offline-layout-only", mode: "with_tool", report: {
      mode: "with_tool", totals: { confirmedRaw: 45, confirmedMax: 46, plannedMax: 48 }, coverage,
      bySubject: {}, byAnswerKind: {}, perQuestion: [],
    } };
    const app = new ExamApp(tui);
    try {
      const lines = app.render(80);
      const plain = stripTerminalSequences(lines.join("\n"));
      expect(visibleWidth(coverageLines(coverage)[0]!)).toBeGreaterThan(80);
      for (const value of ["45 / 46", "计划满分 48", "结果未知 2", "已中断 1", "达到保护上限 1", "不支持输入 1", "未执行失败 1", "待人工复核 3"]) expect(plain).toContain(value);
      expect(plain).not.toContain('"exec:');
      expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    } finally { app.dispose(); }
  });
});
