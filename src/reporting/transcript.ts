/**
 * Render a human-readable transcript of ONE attempt from recorded events
 * (AGENTS.md §11: keep the whole obtainable conversation + tool process). Used
 * so the user can inspect the model's solving process, tool calls and final
 * answer sheet — not just a score.
 */
import type { PublicQuestion } from "../shared/contracts.js";
import { buildUserContent } from "../runner/prompt.js";
import { summarizeRequests, TOKEN_FIELDS, TrialMetricsSchema, type MetricTotal } from "../shared/metrics.js";

interface Ev {
  type?: string;
  message?: { role?: string; content?: unknown; stopReason?: string; usage?: unknown };
  toolName?: string;
  args?: unknown;
  toolCallId?: string;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  metrics?: unknown;
}

function contentText(content: unknown): { text: string; toolCalls: Array<{ name: string; args: unknown }> } {
  let text = "";
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      const bb = b as { type?: string; text?: string; name?: string; arguments?: unknown };
      if (bb.type === "text" && typeof bb.text === "string") text += bb.text;
      if (bb.type === "toolCall") toolCalls.push({ name: String(bb.name), args: bb.arguments });
    }
  } else if (typeof content === "string") {
    text = content;
  }
  return { text, toolCalls };
}

export interface TranscriptInput {
  trialId: string;
  mode: string;
  provider: string;
  modelId: string;
  question: PublicQuestion;
  events: Ev[];
  answerSheet: string | null;
  executionStatus: string;
}

export interface UsageSummary {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  totalTokens: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  replies: number;
  toolCalls: number;
  coverage: Record<string, MetricTotal>;
}

/** Accumulate token usage across ALL assistant replies of an attempt (P2-8) —
 *  not just the last message. Cost stays unknown unless pricing is verified. */
export function summarizeUsage(events: Ev[]): UsageSummary {
  const recorded = [...events].reverse().find((event) => event.type === "trial_metrics");
  if (recorded) {
    const metrics = TrialMetricsSchema.parse(recorded.metrics);
    const summary = summarizeRequests(metrics.requests);
    return { input: summary.tokens.input.value, output: summary.tokens.output.value, reasoning: summary.tokens.reasoning.value,
      totalTokens: summary.tokens.totalTokens.value, cacheRead: summary.tokens.cacheRead.value, cacheWrite: summary.tokens.cacheWrite.value,
      replies: metrics.requests.length, toolCalls: metrics.toolCalls, coverage: summary.tokens };
  }
  // 旧日志没有原始字段存在性证据，SDK 填入的 0 不能解释为真实零消耗。
  const replies = events.filter((event) => event.type === "message_end" && event.message?.usage);
  const coverage = Object.fromEntries(TOKEN_FIELDS.map((field) => {
    const values = replies.flatMap((event) => {
      const usage = event.message!.usage as Record<string, unknown>;
      const value = field === "input" && typeof usage.totalTokens === "number" && typeof usage.output === "number"
        ? usage.totalTokens - usage.output : usage[field];
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? [value] : [];
    });
    return [field, { value: values.length ? values.reduce((a, b) => a + b, 0) : null, known: values.length, total: replies.length }];
  })) as Record<string, MetricTotal>;
  return { input: coverage.input!.value, output: coverage.output!.value, reasoning: coverage.reasoning!.value,
    totalTokens: coverage.totalTokens!.value, cacheRead: coverage.cacheRead!.value, cacheWrite: coverage.cacheWrite!.value,
    replies: replies.length, toolCalls: events.filter((event) => event.type === "tool_execution_end").length, coverage };
}

export function renderTrialTranscript(input: TranscriptInput): string {
  const L: string[] = [];
  L.push(`# Trial ${input.trialId}`);
  L.push(`- mode: ${input.mode} | provider: ${input.provider} | model: ${input.modelId} | status: ${input.executionStatus}`);
  L.push(`- question: ${input.question.id} (${input.question.subject}, ${input.question.answerKind})`);
  L.push("");
  L.push("## Question (as sent to the model)");
  L.push("```");
  L.push(buildUserContent(input.question));
  L.push("```");
  L.push("");
  L.push("## Process");

  let step = 0;
  for (const e of input.events) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      step++;
      const { text, toolCalls } = contentText(e.message.content);
      L.push(`### Assistant turn ${step}${e.message.stopReason ? ` (stopReason=${e.message.stopReason})` : ""}`);
      if (text.trim()) L.push(text.trim());
      for (const tc of toolCalls) {
        L.push(`→ requests tool \`${tc.name}\` with \`${JSON.stringify(tc.args)}\``);
      }
      L.push("");
    } else if (e.type === "tool_execution_end") {
      const res = e.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const outText = (res?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      L.push(`#### Tool \`${e.toolName}\` ${e.isError ? "(error)" : ""} ${e.durationMs !== undefined ? `${e.durationMs}ms` : ""}`);
      L.push("```");
      L.push(outText.length > 2000 ? outText.slice(0, 2000) + "\n… [truncated in transcript]" : outText);
      L.push("```");
      L.push("");
    }
  }

  L.push("## Final answer sheet");
  L.push("```");
  L.push(input.answerSheet ?? "(none — not a normal completion)");
  L.push("```");
  L.push("");
  const usage = summarizeUsage(input.events);
  L.push("## Usage (accumulated across the attempt; cost unknown unless pricing verified)");
  L.push("```json");
  L.push(JSON.stringify(usage, null, 2));
  L.push("```");
  L.push("");
  return L.join("\n");
}
