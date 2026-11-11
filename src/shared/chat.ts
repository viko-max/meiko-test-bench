import { z } from "zod";
import { IdentifierSchema, ThinkingLevelSchema } from "./contracts.js";
import { TrialMetricsSchema } from "./metrics.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().finite().nonnegative();
export const ChatIdSchema = z.string().regex(/^chat-[a-f0-9-]{36}$/);
export const ChatConfigSchema = z.object({
  profileId: IdentifierSchema, modelId: z.string().min(1), thinkingLevel: ThinkingLevelSchema.default("off"),
  maxTotalTokens: positive.default(50000), maxOutputTokens: positive.default(4096),
  requestTimeoutMs: positive.max(2147483647).default(60000), turnTimeoutMs: positive.max(2147483647).default(180000),
  /** 供应商原生网络搜索开关；旧配置与旧轮次缺省为 false。 */
  nativeSearch: z.boolean().default(false),
}).strict();
export type ChatConfig = z.infer<typeof ChatConfigSchema>;

export const ChatModelSchema = z.object({
  profileId: z.string(), modelId: z.string(), provider: z.string(), api: z.string(), baseUrl: z.string(),
  identity: z.string(), contextWindow: positive, maxTokens: positive,
}).strict();
export type ChatModel = z.infer<typeof ChatModelSchema>;
const ChatResponseSchema = z.object({
  role: z.literal("assistant"), content: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()),
  api: z.string(), provider: z.string(), model: z.string(), timestamp: count,
  stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
  usage: z.object({
    input: count, output: count, cacheRead: count, cacheWrite: count, totalTokens: count,
    reasoning: count.optional(), cacheWrite1h: count.optional(),
    cost: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, total: count }).strict(),
  }).strict(),
}).strict();
export const ChatTurnSchema = z.object({
  id: z.string().uuid(), input: z.string().trim().min(1).max(20000), startedAt: z.string().datetime(), endedAt: z.string().datetime().optional(),
  status: z.enum(["running", "completed", "truncated", "cancelled", "outcome_unknown", "error"]),
  requestStarted: z.boolean(), config: ChatConfigSchema, model: ChatModelSchema,
  response: ChatResponseSchema.optional(), partialText: z.string().optional(), error: z.string().optional(),
  metrics: TrialMetricsSchema.optional(),
}).strict();
export type ChatTurn = z.infer<typeof ChatTurnSchema>;
export const ChatSessionSchema = z.object({
  schema: z.literal("meiko-chat/1"), id: ChatIdSchema, title: z.string().min(1).max(100),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  maxTotalTokens: positive, turns: z.array(ChatTurnSchema),
}).strict().superRefine((session, context) => {
  const ids = new Set<string>();
  session.turns.forEach((turn, index) => {
    if (ids.has(turn.id) || turn.config.maxTotalTokens !== session.maxTotalTokens || index < session.turns.length - 1 && turn.status === "running") {
      context.addIssue({ code: "custom", message: "聊天轮次、预算或执行状态不一致。" });
    }
    ids.add(turn.id);
  });
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;
