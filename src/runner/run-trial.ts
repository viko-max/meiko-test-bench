/**
 * Run ONE exam attempt (AGENTS.md §7/§11). Subscribes to agent events for the
 * record, derives the final answer sheet from the last complete assistant
 * message, and maps to an execution status. Never auto-retries; outcome-unknown
 * stays outcome-unknown for the user to decide.
 */
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExecutionStatus, PublicQuestion, TerminationCause } from "../shared/contracts.js";
import { AnswerIsolationError, ContractError } from "../shared/errors.js";
import type { TrialRecorder } from "../storage/recorder.js";
import type { LimitGuard } from "./limits.js";
import { buildUserContent } from "./prompt.js";

export interface RunTrialParams {
  agent: Agent;
  question: PublicQuestion;
  guard: LimitGuard;
  recorder: TrialRecorder;
  images?: ImageContent[];
  signal?: AbortSignal; // stop signal (TS-2)
  onEvent?: (event: AgentEvent) => void;
  /** with_tool 展示公开附件相对名；默认保持原题面（逐字不变）。 */
  includeAssetRefs?: boolean;
}

export interface TrialOutcome {
  executionStatus: ExecutionStatus;
  finalAnswerSheet: string | null;
  stopReason: string | null;
  terminationCause: TerminationCause;
  errorMessage: string | null;
  truncated: boolean;
  eventCount: number;
  /** Set when persisting the answer sheet failed AFTER the answer was obtained;
   *  the answer is still returned (never dropped), the write failure is surfaced. */
  answerSheetError?: string;
}

function extractText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => {
        const bb = b as { type?: unknown; text?: unknown };
        return bb?.type === "text" && typeof bb.text === "string";
      })
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function lastAssistantText(messages: AgentMessage[]): { text: string; stopReason: string | null; errorMessage: string | null } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (m?.role === "assistant") {
      return {
        text: extractText(m),
        stopReason: m.stopReason ?? null,
        errorMessage: m.errorMessage ?? null,
      };
    }
  }
  return { text: "", stopReason: null, errorMessage: null };
}

export async function runTrial(p: RunTrialParams): Promise<TrialOutcome> {
  let eventCount = 0;
  const unsubscribe = p.agent.subscribe((event: AgentEvent) => {
    eventCount += 1;
    p.recorder.recordEvent(event);
    p.onEvent?.(event);
  });

  let threw: unknown = null;
  // P2-8: actively cancel at the total-run-time deadline instead of only checking
  // after a turn (which let a slow tool run well past the limit).
  const abort = (cause: "user_stop" | "total_time_limit") => {
    p.guard.stop(cause);
    try {
      void p.agent.abort();
    } catch {
      /* best effort */
    }
  };
  const onAbort = () => abort("user_stop");
  if (p.signal) {
    if (p.signal.aborted) onAbort();
    else p.signal.addEventListener("abort", onAbort, { once: true });
  }
  const deadline = setTimeout(() => abort("total_time_limit"), Math.max(0, p.guard.totalRunTimeMs - p.guard.elapsedMs()));
  try {
    if (!p.signal?.aborted) {
      const userContent = buildUserContent(p.question, { includeAssetRefs: p.includeAssetRefs ?? false });
      await p.agent.prompt(userContent, p.images ?? []);
      await p.agent.waitForIdle();
    }
  } catch (err) {
    threw = err;
  } finally {
    clearTimeout(deadline);
    p.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }

  const messages = p.agent.state.messages as AgentMessage[];
  const last = lastAssistantText(messages);
  const answerSheet = last.text.trim().length > 0 ? last.text : null;
  const truncated = last.stopReason === "length" || last.stopReason === "maxTokens" || last.stopReason === "max_tokens";

  let executionStatus: ExecutionStatus;
  let terminationCause: TerminationCause;
  const stopped = p.guard.terminationCause;
  if (stopped === "user_stop") {
    executionStatus = "interrupted";
    terminationCause = stopped;
  } else if (stopped && ["total_time_limit", "context_limit", "turn_limit", "tool_call_limit", "output_token_limit", "batch_token_budget"].includes(stopped)) {
    executionStatus = "limit_reached";
    terminationCause = stopped;
  } else if (threw instanceof AnswerIsolationError || threw instanceof ContractError) {
    executionStatus = "unsupported_input";
    terminationCause = "input_rejected";
  } else if (threw !== null) {
    executionStatus = "outcome_unknown";
    terminationCause = "execution_error";
  } else if (last.stopReason === "aborted") {
    executionStatus = "interrupted";
    terminationCause = "provider_abort";
  } else if (last.stopReason === "error") {
    executionStatus = "outcome_unknown";
    terminationCause = "provider_error";
  } else if (answerSheet) {
    executionStatus = "completed";
    terminationCause = truncated ? "output_token_limit" : "completed";
  } else {
    executionStatus = "outcome_unknown";
    terminationCause = truncated ? "output_token_limit" : "empty_response";
  }

  let answerSheetError: string | undefined;
  if (answerSheet && executionStatus === "completed") {
    try {
      p.recorder.setAnswerSheet(answerSheet);
    } catch (e) {
      answerSheetError = (e as Error).message; // keep the answer; surface the write failure (P1-4b)
    }
  }

  return {
    executionStatus,
    finalAnswerSheet: answerSheet,
    stopReason: last.stopReason,
    terminationCause,
    errorMessage: last.errorMessage ?? (threw instanceof Error ? threw.message : null),
    truncated,
    eventCount,
    ...(answerSheetError ? { answerSheetError } : {}),
  };
}
