/**
 * Shared task framing (AGENTS.md §3/§6). Both modes share the same public
 * question and instruct autonomous, free-form answering with no web search and
 * no forced plan/review/tool-use. Tool descriptions are injected per mode.
 */
import type { AnswerMode } from "../shared/contracts.js";

export const PROMPT_VERSION = "v2";

const COMMON = `You are taking an exam. Answer the question on your own.

Rules:
- Do NOT use web search or any external/online resource. Solve from the question and your own knowledge.
- You decide your own steps: whether to plan, recheck, or use tools, and when to submit. None of these are required.
- Write your answer freely in readable prose. There is no required structure and no separate "final answer" box.
- When you are done, end with a clear, readable submission of your full answer.
- Be honest: if you cannot determine something, say so rather than inventing it.`;

export function buildSystemPrompt(mode: AnswerMode, toolNames: string[]): string {
  if (mode === "without_tool") {
    return `${COMMON}\n- No tools are available in this attempt. Reason and answer directly.`;
  }
  const toolList = toolNames.length > 0 ? toolNames.map((t) => `  - ${t}`).join("\n") : "  (none)";
  return `${COMMON}\n- You MAY use these tools if you choose (using them is optional):\n${toolList}\n- Tool results return to you in this same attempt; decide whether to keep going or submit.`;
}
