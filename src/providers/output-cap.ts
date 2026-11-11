import { clampThinkingBudgetToAnswerRoom } from "@earendil-works/pi-ai/api/simple-options";
import { LimitExceededError } from "../shared/errors.js";

/** SDK 可能把 thinking budget 加到输出上限；在最终请求对象中重新约束总输出。 */
export function capOutputPayload(payload: unknown, cap: number): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const result = { ...payload } as Record<string, unknown>;
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    if (typeof result[key] === "number") result[key] = Math.min(result[key] as number, cap);
  }
  for (const [key, field] of [["generationConfig", "maxOutputTokens"], ["config", "maxOutputTokens"], ["inferenceConfig", "maxTokens"]] as const) {
    const raw = result[key];
    if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>)[field] === "number") {
      result[key] = { ...raw, [field]: Math.min((raw as Record<string, number>)[field]!, cap) };
    }
  }
  const thinking = result.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") {
    const budget = clampThinkingBudgetToAnswerRoom(thinking.budget_tokens, Math.min(typeof result.max_tokens === "number" ? result.max_tokens : cap, cap));
    if (budget < 1024) throw new LimitExceededError("maxOutputTokens", "输出上限不足以同时保留 thinking 最低预算和答卷空间，请明确调整配置；请求未发送。");
    result.thinking = { ...thinking, budget_tokens: budget };
  }
  return result;
}
