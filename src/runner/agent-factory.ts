/**
 * Assemble a Pi Agent for one exam attempt with all harness invariants wired
 * (AGENTS.md §5/§6/§7):
 *  - convertToLlm: answer isolation — only standard LLM messages reach the model
 *  - transformContext: NO auto-compaction / summarization (pass-through)
 *  - finishTurn: autonomous submit + turn/time protection limits (no forced self-check)
 *  - beforeToolCall: tool-call budget guard
 *  - prepareRequest: snapshot each outgoing request for the record
 *  - toolExecution: sequential (serial default; not a claim of equal resources)
 */
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AnswerMode, ProtectionLimits, ThinkingLevel } from "../shared/contracts.js";
import type { TrialRecorder } from "../storage/recorder.js";
import type { LimitGuard } from "./limits.js";
import { contextBudget } from "./context-budget.js";
import { LimitExceededError } from "../shared/errors.js";
import { capOutputPayload } from "../providers/output-cap.js";

export interface BuildAgentParams {
  streamFn: StreamFn;
  systemPrompt: string;
  model: Model<Api>;
  tools: AgentTool[];
  mode: AnswerMode;
  limits: ProtectionLimits;
  guard: LimitGuard;
  recorder: TrialRecorder;
  onThinkingLevel?: (level: string) => void;
  thinkingLevel?: ThinkingLevel;
}

export function buildAgent(p: BuildAgentParams): Agent {
  return new Agent({
    initialState: {
      systemPrompt: p.systemPrompt,
      model: p.model,
      tools: p.tools, // empty for without_tool
      thinkingLevel: p.thinkingLevel ?? "off",
    },
    streamFn: (model, context, options) => p.streamFn(model, context, { ...options, maxTokens: Math.min(p.limits.maxOutputTokens, model.maxTokens) }),
    onPayload: (payload, model) => {
      try { return capOutputPayload(payload, Math.min(p.limits.maxOutputTokens, model.maxTokens)); }
      catch (error) { if (error instanceof LimitExceededError) p.guard.stop("output_token_limit"); throw error; }
    },
    toolExecution: "sequential",
    convertToLlm: (messages): Message[] => {
      const out: Message[] = [];
      for (const m of messages) {
        const role = (m as { role?: string }).role;
        // Pass through all LLM-compatible roles (the system message carries the
        // prompt + tool declarations). Drop only UI-only/custom/notification.
        if (role === "system" || role === "user" || role === "assistant" || role === "toolResult") {
          out.push(m as Message);
        }
      }
      return out;
    },
    transformContext: async (messages) => messages,
    finishTurn: (turn) => {
      p.guard.countTurn();
      if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
      const over = p.guard.exceeded();
      const continuing = turn.message.content.some((block) => block.type === "toolCall");
      if (over && (over !== "maxTurns" || continuing)) {
        p.guard.stop(over === "maxTurns" ? "turn_limit" : over === "maxToolCalls" ? "tool_call_limit" : "total_time_limit");
        return { action: "end" };
      }
      // Preserve normal scheduling: the run ends on its own when the assistant
      // submits with no tool calls. We never force an extra self-check turn.
      return undefined;
    },
    beforeToolCall: async () => {
      if (p.guard.elapsedMs() >= p.guard.totalRunTimeMs) {
        p.guard.stop("total_time_limit");
        return { block: true, reason: "total run time exceeded", terminate: true };
      }
      const withinBudget = p.guard.countToolCall();
      if (!withinBudget) {
        p.guard.stop("tool_call_limit");
        return { block: true, reason: `tool-call budget (${p.limits.maxToolCalls}) exceeded`, terminate: true };
      }
      return undefined;
    },
    prepareRequest: (req) => {
      if (p.guard.elapsedMs() >= p.guard.totalRunTimeMs) {
        p.guard.stop("total_time_limit");
        throw new LimitExceededError("totalRunTimeMs", "request not sent");
      }
      const budget = contextBudget(req.model, req.context.messages as Message[], p.limits.maxOutputTokens);
      p.recorder.recordEvent({ type: "context_check", ...budget });
      if (budget.remainingTokens < 0) {
        p.guard.stop("context_limit");
        throw new LimitExceededError("contextWindow", `estimated input=${budget.estimatedInputTokens}, reserved output=${budget.outputReserve}, margin=${budget.margin}, window=${budget.contextWindow}; request not sent`);
      }
      p.onThinkingLevel?.(req.thinkingLevel);
      p.recorder.recordRequest({
        kind: "provider_request",
        provider: req.model.provider,
        model: req.model.id,
        thinkingLevel: req.thinkingLevel,
        messageCount: req.context.messages.length,
        at: new Date().toISOString(),
      });
    },
  });
}
