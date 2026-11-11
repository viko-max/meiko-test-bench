import { z } from "zod";

const count = z.number().finite().nonnegative();
export const TOKEN_FIELDS = ["input", "uncachedInput", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"] as const;
export type TokenField = typeof TOKEN_FIELDS[number];
export const TokenUsageSchema = z.object({
  input: count.nullable(), uncachedInput: count.nullable(), output: count.nullable(), reasoning: count.nullable(),
  cacheRead: count.nullable(), cacheWrite: count.nullable(), totalTokens: count.nullable(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export const emptyUsage = (): TokenUsage => ({ input: null, uncachedInput: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, totalTokens: null });

export const RequestMetricsSchema = z.object({
  id: z.string(), api: z.string(), startedAt: z.string(), lastActivityAt: z.string(), endedAt: z.string().nullable(),
  elapsedMs: count, firstOutputMs: count.nullable(), firstTextMs: count.nullable(),
  status: z.enum(["waiting", "streaming", "completed", "failed", "cancelled"]),
  phase: z.enum(["waiting", "reasoning", "answering", "tool_call"]),
  requestedThinkingLevel: z.string().nullable(), sentThinking: z.string().nullable(),
  reportedThinkingLevel: z.string().nullable(),
  usage: TokenUsageSchema, usageSource: z.enum(["native", "pi_positive", "unavailable"]),
  evidence: z.record(count),
});
export type RequestMetrics = z.infer<typeof RequestMetricsSchema>;
export const TrialMetricsSchema = z.object({
  version: z.literal(1), elapsedMs: count, requests: z.array(RequestMetricsSchema), toolCalls: count, toolErrors: count,
});
export type TrialMetrics = z.infer<typeof TrialMetricsSchema>;

export interface MetricTotal { value: number | null; known: number; total: number }
export interface MetricsSummary {
  requests: number;
  incompleteRequests: number;
  tokens: Record<TokenField, MetricTotal>;
  cacheHitRate: number | null;
  requestTps: number | null;
  batchTps: number | null;
  firstOutputMs: number | null;
  firstOutputKnown: number;
}

/** 推理 Token 属于 output 的子集；缓存读写包含在归一后的 input 中，均不能再加一次。 */
export function summarizeRequests(requests: RequestMetrics[], elapsedMs?: number): MetricsSummary {
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => {
    const known = requests.flatMap((request) => request.usage[field] === null ? [] : [request.usage[field]!]);
    return [field, { value: known.length ? known.reduce((a, b) => a + b, 0) : null, known: known.length, total: requests.length }];
  })) as Record<TokenField, MetricTotal>;
  const complete = (field: TokenField) => requests.length > 0 && tokens[field].known === requests.length;
  const finished = requests.length > 0 && requests.every((request) => request.status === "completed");
  const duration = requests.reduce((sum, request) => sum + request.elapsedMs, 0);
  const first = requests.flatMap((request) => request.firstOutputMs === null ? [] : [request.firstOutputMs]);
  return {
    requests: requests.length, incompleteRequests: requests.filter((request) => request.status !== "completed").length, tokens,
    cacheHitRate: complete("input") && complete("cacheRead") && tokens.input.value! > 0 && tokens.cacheRead.value! <= tokens.input.value!
      ? tokens.cacheRead.value! / tokens.input.value! : null,
    requestTps: finished && complete("output") && duration > 0 ? tokens.output.value! * 1000 / duration : null,
    batchTps: finished && complete("output") && elapsedMs !== undefined && elapsedMs > 0 ? tokens.output.value! * 1000 / elapsedMs : null,
    firstOutputMs: first.length ? first.reduce((a, b) => a + b, 0) / first.length : null,
    firstOutputKnown: first.length,
  };
}
