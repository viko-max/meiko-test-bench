import { performance } from "node:perf_hooks";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { emptyUsage, TOKEN_FIELDS, type RequestMetrics, type TrialMetrics } from "../shared/metrics.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** 只提取 usage 数值与推理参数白名单；不复制请求正文、凭据或完整供应商响应。 */
export function applyNativeUsage(metric: RequestMetrics, event: unknown): void {
  const data = object(event);
  let usage: Record<string, unknown>;
  const put = (key: string, value: unknown) => {
    const n = number(value);
    if (n !== null) metric.evidence[key] = n;
  };
  if (metric.api === "openai-completions") {
    const choice = Array.isArray(data.choices) ? object(data.choices[0]) : {};
    usage = object(data.usage ?? choice.usage);
    if (!Object.keys(usage).length) return;
    put("prompt_tokens", usage.prompt_tokens);
    put("completion_tokens", usage.completion_tokens);
    put("total_tokens", usage.total_tokens);
    put("cached_tokens", object(usage.prompt_tokens_details).cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
    put("cache_write_tokens", object(usage.prompt_tokens_details).cache_write_tokens);
    put("reasoning_tokens", object(usage.completion_tokens_details).reasoning_tokens);
    const e = metric.evidence;
    metric.usage = {
      input: e.prompt_tokens ?? null, output: e.completion_tokens ?? null,
      cacheRead: e.cached_tokens ?? null, cacheWrite: e.cache_write_tokens ?? null, reasoning: e.reasoning_tokens ?? null,
      totalTokens: e.total_tokens ?? (e.prompt_tokens !== undefined && e.completion_tokens !== undefined ? e.prompt_tokens + e.completion_tokens : null),
      uncachedInput: e.prompt_tokens !== undefined && e.cached_tokens !== undefined && e.cache_write_tokens !== undefined && e.prompt_tokens >= e.cached_tokens + e.cache_write_tokens
        ? e.prompt_tokens - e.cached_tokens - e.cache_write_tokens : null,
    };
  } else if (metric.api === "anthropic-messages") {
    usage = object(data.usage ?? object(data.message).usage);
    if (!Object.keys(usage).length) return;
    for (const field of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) put(field, usage[field]);
    put("thinking_tokens", object(usage.output_tokens_details).thinking_tokens);
    const e = metric.evidence;
    const input = [e.input_tokens, e.cache_read_input_tokens, e.cache_creation_input_tokens].every((n) => n !== undefined)
      ? e.input_tokens! + e.cache_read_input_tokens! + e.cache_creation_input_tokens! : null;
    metric.usage = {
      input, uncachedInput: e.input_tokens ?? null, output: e.output_tokens ?? null,
      cacheRead: e.cache_read_input_tokens ?? null, cacheWrite: e.cache_creation_input_tokens ?? null, reasoning: e.thinking_tokens ?? null,
      totalTokens: input !== null && e.output_tokens !== undefined ? input + e.output_tokens : null,
    };
  } else return;
  metric.usageSource = Object.keys(metric.evidence).length ? "native" : "unavailable";
}

export class RequestMetricsCollector {
  private readonly started = performance.now();
  private readonly requests: RequestMetrics[] = [];
  private thinking: string | null = null;
  toolCalls = 0;
  toolErrors = 0;
  constructor(private readonly emit?: (metric: RequestMetrics) => void) {}
  setThinkingLevel(level: string): void { this.thinking = level; }
  snapshot(): TrialMetrics {
    return { version: 1, elapsedMs: performance.now() - this.started, requests: structuredClone(this.requests), toolCalls: this.toolCalls, toolErrors: this.toolErrors };
  }

  wrap(inner: StreamFn): StreamFn {
    return (model, context, options) => {
      const started = performance.now();
      const at = new Date().toISOString();
      const metric: RequestMetrics = {
        id: `request-${this.requests.length + 1}`, api: model.api, startedAt: at, lastActivityAt: at, endedAt: null,
        elapsedMs: 0, firstOutputMs: null, firstTextMs: null, status: "waiting", phase: "waiting",
        requestedThinkingLevel: this.thinking, sentThinking: null, reportedThinkingLevel: null,
        usage: emptyUsage(), usageSource: "unavailable", evidence: {},
      };
      this.requests.push(metric);
      let lastPublish = -Infinity;
      let terminal = false;
      const publish = (force = false) => {
        metric.elapsedMs = performance.now() - started;
        if (force || performance.now() - lastPublish >= 500) {
          lastPublish = performance.now();
          this.emit?.(structuredClone(metric));
        }
      };
      const activity = () => { metric.lastActivityAt = new Date().toISOString(); publish(); };
      const finish = (status: RequestMetrics["status"]) => {
        if (terminal) return;
        terminal = true;
        metric.status = status;
        metric.endedAt = new Date().toISOString();
        publish(true);
      };
      const finishMessage = (message: AssistantMessage, failed: boolean) => {
        if (terminal) return;
        // 没有原始证据时，SDK 的零值不代表供应商明确报告零消耗。
        if (metric.usageSource !== "native") {
          const u = message.usage;
          const positive = (n: unknown) => number(n) !== null && Number(n) > 0 ? Number(n) : null;
          metric.usage = {
            input: positive(u.input + u.cacheRead + u.cacheWrite), uncachedInput: positive(u.input), output: positive(u.output),
            reasoning: positive(u.reasoning), cacheRead: positive(u.cacheRead), cacheWrite: positive(u.cacheWrite), totalTokens: positive(u.totalTokens),
          };
          metric.usageSource = TOKEN_FIELDS.some((field) => metric.usage[field] !== null) ? "pi_positive" : "unavailable";
        }
        finish(failed ? (message.stopReason === "aborted" ? "cancelled" : "failed") : "completed");
      };
      publish(true);
      let source: ReturnType<StreamFn>;
      try {
        source = inner(model, context, {
          ...options,
          onPayload: async (payload, responseModel) => {
            const replacement = await options?.onPayload?.(payload, responseModel);
            if (terminal) return replacement;
            const p = object(replacement ?? payload);
            const effort = p.reasoning_effort ?? object(p.reasoning).effort ?? object(p.output_config).effort;
            const thinking = object(p.thinking);
            metric.sentThinking = typeof effort === "string" ? effort : typeof thinking.type === "string"
              ? `${thinking.type}${number(thinking.budget_tokens) === null ? "" : ` / budget=${thinking.budget_tokens}`}` : null;
            activity();
            return replacement;
          },
          onProviderStreamEvent: async (event, responseModel) => {
            if (!terminal) { applyNativeUsage(metric, event); activity(); }
            await options?.onProviderStreamEvent?.(event, responseModel);
          },
        });
      } catch (error) { finish(options?.signal?.aborted ? "cancelled" : "failed"); throw error; }
      const consume = async function* () {
        try {
          for await (const event of await source) {
            if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
              if (event.delta.length) {
                const elapsed = performance.now() - started;
                metric.firstOutputMs ??= elapsed;
                if (event.type === "text_delta") metric.firstTextMs ??= elapsed;
                metric.phase = event.type === "text_delta" ? "answering" : event.type === "thinking_delta" ? "reasoning" : "tool_call";
                metric.status = "streaming";
              }
            }
            metric.lastActivityAt = new Date().toISOString();
            if (event.type === "done" || event.type === "error") {
              const message = event.type === "done" ? event.message : event.error;
              finishMessage(message, event.type === "error");
            } else publish();
            yield event;
          }
          if (!terminal) finish("failed");
        } catch (error) { finish(options?.signal?.aborted ? "cancelled" : "failed"); throw error; }
        finally { if (!terminal) finish("cancelled"); }
      };
      // Agent 消费迭代器；result 委托同一条流，绝不重新发请求。
      return { [Symbol.asyncIterator]: consume, result: async () => {
        try {
          const message = await (await source).result();
          finishMessage(message, message.stopReason === "error" || message.stopReason === "aborted");
          return message;
        } catch (error) { finish(options?.signal?.aborted ? "cancelled" : "failed"); throw error; }
      } } as unknown as AssistantMessageEventStream;
    };
  }
}
