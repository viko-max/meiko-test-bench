import type { Api, Model, Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { EXECUTION_POLICY_VERSION } from "../shared/execution-policy.js";

export function contextBudget(model: Model<Api>, messages: readonly Message[], maxOutputTokens: number) {
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) throw new Error("模型必须提供有效的上下文容量和输出上限。");
  const estimate = estimateContextTokens(messages);
  const outputReserve = Math.min(maxOutputTokens, model.maxTokens);
  // SDK 估算包含系统消息、工具声明和图片；额外留出协议及估算误差空间。
  const margin = Math.max(128, Math.ceil(model.contextWindow * 0.05));
  const estimatedInputTokens = estimate.tokens + messages.length * 16;
  return { policyVersion: EXECUTION_POLICY_VERSION, method: "pi-estimate", estimated: true,
    estimatedInputTokens, outputReserve, margin, contextWindow: model.contextWindow,
    remainingTokens: model.contextWindow - estimatedInputTokens - outputReserve - margin };
}
