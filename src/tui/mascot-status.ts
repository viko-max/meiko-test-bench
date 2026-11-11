import type { TaskStatus } from "../service/task-service.js";
import type { MascotColorway } from "./mascot.js";
import type { MetricsSummary } from "../shared/metrics.js";

export const MASCOT_ACCENTS: Record<MascotColorway, string> = {
  orange: "\x1b[38;2;111;211;204m",
  pink: "\x1b[38;2;232;157;181m",
  black: "\x1b[38;2;164;184;235m",
};

export interface MascotStatus {
  label: string;
  detail: string;
  tone: "neutral" | "active" | "success" | "warning" | "error";
}

/** 从任务事实展示状态；并发题目分组计数，不把某一题的阶段当成整个批次。 */
export function mascotStatus(status?: TaskStatus): MascotStatus {
  if (!status) return { label: "待命", detail: "未连接任务", tone: "neutral" };
  if (status.state === "error") return { label: "任务异常", detail: "检查运行记录", tone: "error" };
  if (status.state === "budget_paused") return { label: "预算暂停", detail: "检查预算记录", tone: "warning" };
  if (status.state === "stopped") return { label: "已停止", detail: "查看已存答卷", tone: "warning" };
  const questions = status.telemetry?.questions ?? [];
  if (status.state === "done") {
    if (!questions.length) return { label: "已结束", detail: "题目状态未提供", tone: "neutral" };
    const issues = questions.filter((question) => !["completed", "loaded"].includes(question.state) ||
      (question.terminationCause !== undefined && question.terminationCause !== "completed")).length;
    return issues ? { label: "已结束", detail: `异常 ${issues} 题`, tone: "warning" }
      : { label: "已完成", detail: "查看成绩与覆盖", tone: "success" };
  }
  const phases = [
    { label: "工具", states: ["tool", "tool_call"] },
    { label: "推理", states: ["reasoning"] },
    { label: "输出", states: ["answering", "streaming"] },
    { label: "等待", states: ["waiting", "running"] },
  ].map((phase) => ({ ...phase, count: questions.filter((question) => phase.states.includes(question.state)).length }))
    .filter((phase) => phase.count > 0);
  if (!phases.length) return { label: "准备请求", detail: "等待任务事件", tone: "active" };
  return {
    label: phases.length > 1 ? "并发作答" : phases[0]!.label === "工具" ? "工具调用" : `${phases[0]!.label}中`,
    detail: phases.map((phase) => `${phase.label} ${phase.count}`).join(" · "),
    tone: "active",
  };
}

export function runtimeStatusLine(summary: MetricsSummary, thinking?: string | null): string {
  const tps = summary.requestTps === null ? "未提供" : summary.requestTps.toFixed(1);
  const cache = summary.cacheHitRate === null ? "未提供" : `${(summary.cacheHitRate * 100).toFixed(1)}%`;
  const tokens = summary.tokens.totalTokens;
  const total = tokens.value === null ? "未提供" : `${tokens.value}${tokens.known < tokens.total ? "（部分已知）" : ""}`;
  return `TPS(含等待) ${tps} · 缓存 ${cache}${thinking === undefined ? "" : ` · 所选题推理请求 ${thinking ?? "未记录"}`} · Token ${total}`;
}
