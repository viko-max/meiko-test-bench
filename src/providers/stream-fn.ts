/**
 * Exam stream function (AGENTS.md §6/§11). Wraps Models.streamSimple and FORCES
 * maxRetries:0 on every exam request so transport-layer auto-retry can never
 * silently turn an "outcome unknown" into a second billed answer. Also threads
 * the request timeout (-> provider timeoutMs -> SDK timeout) and the output
 * token cap (maxTokens, from RunSpec.limits.maxOutputTokens) so a runaway
 * generation is bounded. A resettable Harness watchdog additionally bounds
 * inactivity after connection; the Agent's abort signal is forwarded as well.
 */
import type { Api, AssistantMessageEventStream, Model, Models, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { RequestScheduler } from "../runner/request-scheduler.js";
import { ProtectionLimitsSchema } from "../shared/contracts.js";
import { watchStream } from "./stream-watchdog.js";

export const EXAM_STREAM_MAX_RETRIES = 0;
const DEFAULT_IDLE_TIMEOUT_MS = ProtectionLimitsSchema.parse({}).requestTimeoutMs;

export interface ExamStreamOpts {
  timeoutMs?: number;
  maxTokens?: number;
}

export function makeExamStreamFn(models: Models, opts: ExamStreamOpts = {}): StreamFn {
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const pinned = {
      ...options,
      maxRetries: EXAM_STREAM_MAX_RETRIES,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      maxTokens: Math.min(model.maxTokens, opts.maxTokens ?? options?.maxTokens ?? ProtectionLimitsSchema.parse({}).maxOutputTokens, options?.maxTokens ?? Number.POSITIVE_INFINITY),
    } as SimpleStreamOptions;
    // SDK 的 timeout 不保证约束已连接的挂起流；每个请求另设可重置的空闲看门狗。
    return watchStream((m, c, o) => models.streamSimple(m, c, o), model, context, pinned, pinned.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  };
}

/**
 * Wrap a StreamFn so EVERY model request passes through the shared-key scheduler
 * (P1-D): the slot is acquired BEFORE the request is issued and released only
 * when the stream ends. A post-tool follow-up request is therefore rate-limited
 * too — not just the first request of a trial.
 */
export function scheduledStreamFn(inner: StreamFn, scheduler: RequestScheduler, groupOf: (model: Model<Api>) => string): StreamFn {
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const group = groupOf(model);
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    let release: (() => void) | undefined;
    let startPromise: Promise<AssistantMessageEventStream> | undefined;
    const ensureStarted = (): Promise<AssistantMessageEventStream> =>
      (startPromise ??= (async () => {
        release = await scheduler.acquire(group, signal);
        return inner(model, context, options);
      })());
    return {
      [Symbol.asyncIterator]: async function* () {
        try {
          const stream = await ensureStarted(); // acquire + init inside the release guard
          yield* stream as unknown as AsyncGenerator<unknown>;
        } finally {
          release?.();
        }
      },
      result: async () => {
        try {
          const stream = await ensureStarted();
          return await stream.result();
        } finally {
          release?.();
        }
      },
    } as unknown as AssistantMessageEventStream;
  };
}
