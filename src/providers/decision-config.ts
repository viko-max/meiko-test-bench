/**
 * Load + validate configs/decision.json（第二阶段 /review 决策模型配置）。
 * 与 models.json 同一套安全边界：只允许凭据的环境变量名，任何 credential 形态
 * 的值或含秘密的键都被拒绝；`$` 开头的文档键（如 `$comment`）先剥离再解析。
 * 缺文件返回 undefined（调用侧回退默认 profile）；文件存在但损坏必须报错，
 * 绝不静默默认。
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { DecisionProviderProfileSchema, type DecisionProviderProfile } from "../shared/decision.js";
import { assertNoCredentials } from "../shared/creds.js";
import { stripDocKeys } from "./models-config.js";

const DecisionConfigSchema = z
  .object({
    profiles: z.array(DecisionProviderProfileSchema).min(1),
  })
  .strict();

export type DecisionConfig = z.infer<typeof DecisionConfigSchema>;

export function loadDecisionProfiles(path: string): DecisionProviderProfile[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  assertNoCredentials(parsed, path);
  return DecisionConfigSchema.parse(stripDocKeys(parsed)).profiles;
}
