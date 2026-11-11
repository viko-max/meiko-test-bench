import type { MetricTotal, MetricsSummary, RequestMetrics } from "../shared/metrics.js";

export const metricNumber = (value: number | null, digits = 1): string => value === null ? "未提供" : value.toFixed(digits);
export const seconds = (value: number | null): string => value === null ? "未提供" : `${(value / 1000).toFixed(1)}s`;
export function metricTotal(metric: MetricTotal): string {
  if (metric.value === null) return "未提供";
  return `${metric.value}${metric.known < metric.total ? `（已知 ${metric.known}/${metric.total}）` : ""}`;
}
export function summaryLines(summary: MetricsSummary): string[] {
  const t = summary.tokens;
  return [
    `Token 输入 ${metricTotal(t.input)} · 输出 ${metricTotal(t.output)} · 推理 ${metricTotal(t.reasoning)}`,
    `缓存 读 ${metricTotal(t.cacheRead)} · 写 ${metricTotal(t.cacheWrite)} · 命中 ${summary.cacheHitRate === null ? "未提供" : `${(summary.cacheHitRate * 100).toFixed(1)}%`}`,
    `TPS 请求均速(含等待) ${metricNumber(summary.requestTps)} · 批次吞吐 ${metricNumber(summary.batchTps)}`,
    `首输出均值 ${seconds(summary.firstOutputMs)} · 记录 ${summary.firstOutputKnown}/${summary.requests} · 未确认完成 ${summary.incompleteRequests}`,
  ];
}
export const STATE_LABELS: Record<string, string> = {
  queued: "排队", running: "准备请求", waiting: "等待接口/调度", reasoning: "推理中", answering: "输出正文",
  tool_call: "生成工具调用", tool: "执行工具", streaming: "接收输出", loaded: "已载入记录", completed: "已完成",
  outcome_unknown: "结果未知", interrupted: "已中断", limit_reached: "达到保护上限", unsupported_input: "不支持输入",
  failed_unprocessed: "未执行失败", failed: "请求失败", cancelled: "已取消",
};
const GRADE_LABELS: Record<string, string> = {
  ungraded: "未评分", unscored: "无评分依据", rule_graded: "规则确认", human_confirmed: "人工确认",
  model_preliminary: "模型初评", pending_human_review: "待人工复核", stale: "评分已过期",
};

/** 覆盖字段逐项保留；未知状态显示原标识，不能因为界面未认识而丢掉异常计数。 */
export function coverageLines(coverage: Record<string, number>): string[] {
  const entries = Object.entries(coverage);
  const groups = [
    { prefix: "exec:", heading: "作答状态", labels: STATE_LABELS },
    { prefix: "grade:", heading: "评分状态", labels: GRADE_LABELS },
  ];
  const lines = groups.flatMap(({ prefix, heading, labels }) => {
    const items = entries.filter(([key]) => key.startsWith(prefix));
    return items.length ? [`${heading}  ${items.map(([key, count]) => `${labels[key.slice(prefix.length)] ?? key} ${count}`).join(" · ")}`] : [];
  });
  const other = entries.filter(([key]) => !groups.some(({ prefix }) => key.startsWith(prefix)));
  if (other.length) lines.push(`其他覆盖  ${other.map(([key, count]) => `${key} ${count}`).join(" · ")}`);
  return lines.length ? lines : ["覆盖记录未提供"];
}
export const TERMINATION_LABELS: Record<string, string> = {
  batch_token_budget: "批次 Token 预算不足（该次请求未发送）",
  completed: "自主提交", user_stop: "用户停止", total_time_limit: "整题超时", context_limit: "上下文估算超限",
  turn_limit: "轮数上限", tool_call_limit: "工具次数上限", provider_error: "接口异常", provider_abort: "接口取消",
  execution_error: "执行异常", input_rejected: "输入被拒绝", output_token_limit: "输出长度上限", empty_response: "没有有效答卷",
};
export function requestLines(request: RequestMetrics): string[] {
  return [
    `${request.id} · ${STATE_LABELS[request.status] ?? request.status} · ${request.usageSource === "native" ? "接口 usage" : request.usageSource === "pi_positive" ? "Pi 正数记录" : "usage 未提供"}`,
    `耗时(含等待) ${seconds(request.elapsedMs)} · 首输出 ${seconds(request.firstOutputMs)} · 首正文 ${seconds(request.firstTextMs)}`,
    `推理请求 ${request.requestedThinkingLevel ?? "未记录"} · 发送 ${request.sentThinking ?? "未记录参数"}`,
    `服务端推理回执 ${request.reportedThinkingLevel ?? "未确认"} · 最新活动 ${request.lastActivityAt}`,
  ];
}
