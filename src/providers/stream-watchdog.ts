import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Models, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";

export function watchStream(
  inner: Models["streamSimple"],
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  idleTimeoutMs: number,
): AssistantMessageEventStream {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new Error("Stream idle timeout must be positive and finite");
  const parent = options.signal;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let terminal: AssistantMessage | undefined;
  let rejectStopped!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  // 超时可能在消费者调用 next/result 之前发生，预先处理拒绝，同时保留供消费路径竞速的原 Promise。
  void cancellation.catch(() => {});
  const cleanup = (): void => {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  };
  const stop = (error: Error): void => {
    if (stopped || terminal) return;
    stopped = true;
    cleanup();
    // 先结束本地等待，再取消传输；即使适配器不响应 AbortSignal，也不能一直占用答题任务。
    rejectStopped(error);
    controller.abort(error);
  };
  const onAbort = (): void => {
    const error = new Error("Exam stream cancelled by caller");
    error.name = "AbortError";
    stop(error);
  };
  const activity = (): void => {
    if (stopped || terminal) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error(`STREAM_IDLE_TIMEOUT: no stream activity for ${idleTimeoutMs} ms; request cancelled; outcome unknown; not retried`);
      error.name = "StreamIdleTimeoutError";
      stop(error);
    }, idleTimeoutMs);
  };
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) {
    onAbort();
    throw controller.signal.reason;
  }
  activity();
  let source: AssistantMessageEventStream;
  try {
    source = inner(model, context, {
      ...options,
      signal: controller.signal,
      onResponse: (response, responseModel) => {
        activity();
        return options.onResponse?.(response, responseModel);
      },
      onProviderStreamEvent: (event, eventModel) => {
        // SDK 的原始事件可包含 usage 或其他未变成 Pi delta 的数据，也算流仍有活动。
        activity();
        return options.onProviderStreamEvent?.(event, eventModel);
      },
    });
  } catch (error) {
    cleanup();
    controller.abort();
    throw error;
  }
  return {
    [Symbol.asyncIterator]: async function* () {
      const iterator = source[Symbol.asyncIterator]();
      let ended = false;
      try {
        for (;;) {
          if (stopped) await cancellation;
          const next = await Promise.race([iterator.next(), cancellation]);
          if (next.done) {
            ended = true;
            return;
          }
          activity();
          const event = next.value;
          if (event.type === "done" || event.type === "error") {
            terminal = event.type === "done" ? event.message : event.error;
            cleanup();
          }
          yield event;
        }
      } catch (error) {
        cleanup();
        controller.abort();
        throw error;
      } finally {
        if (!ended && !terminal && !stopped) stop(new Error("Exam stream consumer ended before a terminal event"));
        // 挂起的迭代器可能连 return 都不响应，不能等待它才释放调度槽。
        if (iterator.return) void iterator.return().catch(() => {});
      }
    },
    result: async () => {
      if (stopped) await cancellation;
      if (terminal) return terminal;
      try {
        const message = await Promise.race([source.result(), cancellation]);
        terminal = message;
        cleanup();
        return message;
      } catch (error) {
        cleanup();
        controller.abort();
        throw error;
      }
    },
  } as unknown as AssistantMessageEventStream;
}
