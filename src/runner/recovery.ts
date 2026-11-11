import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadValidAnswers, manifestPath, readManifest } from "./answer-source.js";
import { shortDigest } from "../shared/hashing.js";

export const RecoveryDecisionSchema = z.object({
  questionId: z.string().min(1), trialId: z.string().min(1), token: z.string().min(1),
  by: z.string().trim().min(1), reason: z.string().trim().min(1),
}).strict();
export type RecoveryDecision = z.infer<typeof RecoveryDecisionSchema>;

export async function prepareRecovery(runsRoot: string, runId: string, datasetDir: string, datasetId: string, questionId: string) {
  return (await recoveryContext(runsRoot, runId, datasetDir, datasetId)).prepare(questionId);
}

export async function recoveryContext(runsRoot: string, runId: string, datasetDir: string, datasetId: string) {
  const manifest = readManifest(runsRoot, runId);
  if (!manifest) throw new Error("任务缺少计划，不能重新作答。");
  const answers = await loadValidAnswers(runsRoot, runId, datasetDir, datasetId, manifest.mode);
  const manifestText = readFileSync(manifestPath(runsRoot, runId), "utf8");
  return {
    prepare(questionId: string) {
      const trial = answers.trials.find((t) => t.questionId === questionId);
      const location = trial && answers.locations.get(trial.trialId);
      if (!trial || !location || !["outcome_unknown", "interrupted", "limit_reached", "failed_unprocessed"].includes(trial.executionStatus)) {
        throw new Error("只允许对材料已核实、没有有效完整答卷的异常记录明确重新作答。");
      }
      // 已完成答卷一律排除，不按分数选择，也不复用其他批次的授权。
      const marker = join(runsRoot, location.runId, "trials", location.trialId, "recovery.json");
      if (existsSync(marker)) throw new Error("该记录已发起过补答，请打开对应补答任务查看结果，不能重复提交。");
      const attemptPath = join(runsRoot, location.runId, "trials", location.trialId, "attempt.json");
      const token = shortDigest({ manifest: manifestText, trial,
        source: existsSync(attemptPath) ? readFileSync(attemptPath, "utf8") : null });
      return { questionId, trialId: trial.trialId, token, location, marker, trial };
    },
  };
}
