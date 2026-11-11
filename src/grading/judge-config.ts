import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ProtectionLimitsSchema, ThinkingLevelSchema } from "../shared/contracts.js";
import { assertNoCredentials } from "../shared/creds.js";
import { writeJsonAtomic } from "../shared/json.js";
import { BatchTokenLimitSchema } from "../runner/batch-budget.js";

export const JudgeConfigSchema = z.object({
  version: z.literal(1), profileId: z.string().trim().min(1), modelId: z.string().trim().min(1),
  thinkingLevel: ThinkingLevelSchema.default("off"),
  maxTotalTokens: BatchTokenLimitSchema,
  limits: ProtectionLimitsSchema.superRefine((limits, ctx) => {
    if (limits.requestTimeoutMs > 2147483647 || limits.totalRunTimeMs > 2147483647 || !Number.isSafeInteger(limits.maxOutputTokens)) ctx.addIssue({ code: "custom", message: "裁判时间上限超过系统计时范围，或输出上限不是安全整数。" });
  }),
}).strict();
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;
export type JudgeDraft = Omit<JudgeConfig, "maxTotalTokens"> & { maxTotalTokens: number | null };

export function readJudgeConfig(path: string): JudgeConfig | undefined {
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertNoCredentials(value, path);
  return JudgeConfigSchema.parse(value);
}
export function saveJudgeConfig(path: string, value: JudgeConfig): void {
  assertNoCredentials(value, path);
  writeJsonAtomic(path, JudgeConfigSchema.parse(value));
}
export function defaultJudgeDraft(): JudgeDraft {
  return { version: 1, profileId: "", modelId: "", thinkingLevel: "off", maxTotalTokens: null,
    limits: ProtectionLimitsSchema.parse({ maxOutputTokens: 2048, maxTurns: 1, maxToolCalls: 1 }) };
}
