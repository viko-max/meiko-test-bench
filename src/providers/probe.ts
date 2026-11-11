/**
 * Real capability probe (AGENTS.md §10/§12). Places ONE tiny request through the
 * same exam path (forced maxRetries:0) and reports what actually came back:
 * text, stopReason, usage and latency. Kept separate from formal single-answer
 * exam trials. Unknown fields stay unknown; nothing is fabricated.
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, Models } from "@earendil-works/pi-ai";
import { ProtectionLimitsSchema } from "../shared/contracts.js";
import { InMemoryTrialRecorder } from "../storage/recorder.js";
import { buildAgent } from "../runner/agent-factory.js";
import { LimitGuard } from "../runner/limits.js";
import { makeExamStreamFn } from "./stream-fn.js";
import { withExecutionLease } from "../runner/execution-lock.js";

export interface ProbeResult {
  ok: boolean;
  text: string;
  stopReason: string | null;
  usage: unknown;
  error: string | null;
  latencyMs: number;
  eventCount: number;
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
  }
  return "";
}

export async function probeModel(
  models: Models,
  model: Model<Api>,
  opts: { prompt: string; images?: ImageContent[] },
): Promise<ProbeResult> {
  return withExecutionLease(() => probeModelLocked(models, model, opts));
}

async function probeModelLocked(
  models: Models,
  model: Model<Api>,
  opts: { prompt: string; images?: ImageContent[] },
): Promise<ProbeResult> {
  const started = Date.now();
  const limits = ProtectionLimitsSchema.parse({ maxTurns: 2, requestTimeoutMs: 60000 });
  const recorder = new InMemoryTrialRecorder();
  const guard = new LimitGuard(limits);
  const agent = buildAgent({
    streamFn: makeExamStreamFn(models, { timeoutMs: 180_000, maxTokens: 8192 }),
    systemPrompt: "You are a capability probe. Answer concisely and factually.",
    model,
    tools: [],
    mode: "without_tool",
    limits,
    guard,
    recorder,
  });

  let lastAssistant: unknown;
  let eventCount = 0;
  const unsub = agent.subscribe((e: AgentEvent) => {
    eventCount += 1;
    if (e.type === "message_end" && (e.message as { role?: string }).role === "assistant") lastAssistant = e.message;
  });

  try {
    await agent.prompt(opts.prompt, opts.images ?? []);
    await agent.waitForIdle();
  } finally {
    unsub();
  }

  const stopReason = (lastAssistant as { stopReason?: string } | undefined)?.stopReason ?? null;
  const error = (lastAssistant as { errorMessage?: string } | undefined)?.errorMessage ?? null;
  const text = textOf(lastAssistant);
  return {
    ok: stopReason !== "error" && text.trim().length > 0,
    text,
    stopReason,
    usage: (lastAssistant as { usage?: unknown } | undefined)?.usage ?? null,
    error,
    latencyMs: Date.now() - started,
    eventCount,
  };
}
