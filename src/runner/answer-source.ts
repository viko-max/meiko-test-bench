/**
 * 显式续跑、报告、人工复核和模型初评共同读取保存的计划及答卷来源。
 * 校验运行身份、题目版本和内容摘要；无法确认的来源不计分、不触发新请求。
 * 无清单的旧运行只扫描本地记录，损坏的清单不自动降级为无清单。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../shared/json.js";
import { ProtectionLimitsSchema, ThinkingLevelSchema, TrialSchema, type AnswerMode, type Grade, type PublicQuestion, type ScoringSpec, type Trial } from "../shared/contracts.js";
import { importDataset } from "../dataset/import.js";
import { readArchivedTrial, type ArchivedTrial } from "./archive.js";
import { BatchTokenLimitSchema } from "./batch-budget.js";

export type AnswerSourceStatus = "usable" | "blocked";

export const ResumeConfigSchema = z.object({
  batchTokenLimit: BatchTokenLimitSchema.optional(),
  profileId: z.string().min(1), thinkingLevel: ThinkingLevelSchema,
  limits: ProtectionLimitsSchema, concurrency: z.number().int().min(1),
  pythonInterpreter: z.string().min(1),
  requestSchedulerLimits: z.object({ maxConcurrent: z.number().int().min(1), minIntervalMs: z.number().finite().nonnegative() }).strict().optional(),
}).strict();
export type ResumeConfig = z.infer<typeof ResumeConfigSchema>;

export interface AnswerSource {
  questionId: string;
  runId: string; // dir under runsRoot where the trial.json lives
  trialId: string;
  status: AnswerSourceStatus;
  blockReason?: string;
}

export interface RunManifest {
  budgetRunId?: string;
  recovery?: { sourceRunId: string; questionId: string; trialId: string; by: string; reason: string; at: string };
  schema: "pi-exam-run-manifest/1";
  mode: AnswerMode;
  datasetId: string;
  datasetVersion: string;
  provider: string;
  modelId: string;
  configDigest: string;
  plannedQuestionIds: string[];
  plannedMaxScore: number;
  sources: AnswerSource[];
  batchId?: string;
  promptVersion?: string;
  toolsVersion?: string;
  resumeConfig?: ResumeConfig;
  executionPolicyVersion?: string;
}

const ArchiveName = z.string().min(1).refine((s) => s !== "." && s !== ".." && !/[\\/\0]/.test(s), "invalid archive directory name");
export const RunManifestSchema = z.object({
  budgetRunId: ArchiveName.optional(),
  recovery: z.object({ sourceRunId: ArchiveName, questionId: z.string().min(1), trialId: ArchiveName,
    by: z.string().trim().min(1), reason: z.string().trim().min(1), at: z.string() }).strict().optional(),
  schema: z.literal("pi-exam-run-manifest/1"), mode: z.enum(["without_tool", "with_tool"]),
  datasetId: z.string().min(1), datasetVersion: z.string().min(1),
  provider: z.string().min(1), modelId: z.string().min(1), configDigest: z.string().min(1),
  plannedQuestionIds: z.array(z.string().min(1)), plannedMaxScore: z.number().finite().nonnegative(),
  batchId: z.string().min(1).optional(), promptVersion: z.string().min(1).optional(), toolsVersion: z.string().min(1).optional(),
  resumeConfig: ResumeConfigSchema.optional(),
  executionPolicyVersion: z.string().min(1).optional(),
  sources: z.array(z.object({ questionId: z.string().min(1), runId: ArchiveName, trialId: ArchiveName,
    status: z.enum(["usable", "blocked"]), blockReason: z.string().optional() }).strict()),
}).strict().superRefine((m, ctx) => {
  const plan = new Set(m.plannedQuestionIds);
  if (plan.size !== m.plannedQuestionIds.length) ctx.addIssue({ code: "custom", message: "duplicate planned question" });
  const seen = new Set<string>();
  for (const s of m.sources) {
    if (!plan.has(s.questionId) || seen.has(s.questionId)) ctx.addIssue({ code: "custom", message: `unplanned or duplicate source: ${s.questionId}` });
    seen.add(s.questionId);
  }
});

export function manifestPath(runsRoot: string, runId: string): string {
  ArchiveName.parse(runId);
  return join(runsRoot, runId, "manifest.json");
}

export function writeManifest(runsRoot: string, runId: string, m: RunManifest): void {
  writeJsonAtomic(manifestPath(runsRoot, runId), RunManifestSchema.parse(m));
}

export function readManifest(runsRoot: string, runId: string): RunManifest | undefined {
  const p = manifestPath(runsRoot, runId);
  if (!existsSync(p)) return undefined;
  // 损坏清单不能降级为无清单，避免改变范围或重新发送已执行题目。
  return RunManifestSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

export interface ValidAnswers {
  trials: Trial[];
  grades: Grade[];
  blocked: Array<{ questionId: string; reason: string }>;
  questions: Map<string, PublicQuestion>;
  scorings: Map<string, ScoringSpec>;
  plannedQuestionIds: string[];
  plannedMax: number;
  fromManifest: boolean;
  /** trialId -> the run dir it actually lives in (may be a PRIOR resumed run). */
  locations: Map<string, { runId: string; trialId: string }>;
  archives: Map<string, ArchivedTrial>;
}

/** A minimal outcome_unknown trial so a blocked answer still appears in the report.
 *  身份字段优先沿用被阻止的存档记录（promptVersion/toolsVersion/configDigest 等），
 *  只有无存档可依据时才退回历史默认值；blocked 状态与不计分语义不变。 */
function blockedTrial(questionId: string, reason: string, ds: { datasetId: string; provider: string; modelId: string; configDigest: string; datasetVersion: string }, mode: AnswerMode, questionVersion: string, entry?: ArchivedTrial): Trial {
  const archived = entry?.trial;
  return TrialSchema.parse({
    trialId: `blocked__${questionId}`,
    datasetId: archived?.datasetId ?? ds.datasetId,
    datasetVersion: archived?.datasetVersion ?? ds.datasetVersion,
    questionId,
    questionVersion: archived?.questionVersion ?? questionVersion,
    provider: archived?.provider ?? ds.provider,
    modelId: archived?.modelId ?? ds.modelId,
    mode,
    executionStatus: "outcome_unknown",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(0).toISOString(),
    configDigest: archived?.configDigest ?? ds.configDigest,
    promptVersion: archived?.promptVersion ?? "v1",
    toolsVersion: archived?.toolsVersion ?? "v1",
    finalAnswerSheet: null,
    errorMessage: reason,
  });
}

/**
 * Load + validate the answers a run counted. Prefers the run's saved manifest
 * (plan + provenance); falls back to scanning the run's own trials dir. Every
 * answer is re-checked against the CURRENT dataset: question version + content
 * digest must match, else it is BLOCKED (surfaced outcome_unknown, not counted).
 */
export async function loadValidAnswers(runsRoot: string, runId: string, datasetDir: string, datasetId: string, mode: AnswerMode): Promise<ValidAnswers> {
  ArchiveName.parse(runId);
  const imported = await importDataset({ datasetId, publicDir: join(datasetDir, "public"), scoringDir: join(datasetDir, "scoring") });
  const questions = new Map(imported.entries.filter((e) => e.question).map((e) => [e.questionId, e.question!]));
  const scorings = new Map(imported.entries.filter((e) => e.scoring).map((e) => [e.questionId, e.scoring!]));
  const contentDigests = new Map(imported.entries.filter((e) => e.question).map((e) => [e.questionId, e.contentDigest]));
  const validationErrors = new Map(imported.entries.map((e) => [e.questionId, e.errors]));

  const manifest = readManifest(runsRoot, runId);
  if (manifest && (manifest.datasetId !== datasetId || manifest.mode !== mode)) throw new Error(`manifest does not match requested dataset/mode: ${runId}`);
  const plannedQuestionIds = manifest?.plannedQuestionIds ?? [...questions.keys()];
  const plannedMax = manifest?.plannedMaxScore ?? [...scorings.values()].reduce((a, s) => a + s.maxScore, 0);
  const ds = { datasetId, datasetVersion: manifest?.datasetVersion ?? "1", provider: manifest?.provider ?? "", modelId: manifest?.modelId ?? "", configDigest: manifest?.configDigest ?? "" };

  const trials: Trial[] = [];
  const grades: Grade[] = [];
  const blocked: Array<{ questionId: string; reason: string }> = [];
  const locations = new Map<string, { runId: string; trialId: string }>();
  const archives = new Map<string, ArchivedTrial>();
  const seen = new Set<string>();
  const plan = new Set(plannedQuestionIds);

  const block = (src: AnswerSource, reason: string, entry?: ArchivedTrial): void => {
    const questionId = src.questionId;
    blocked.push({ questionId, reason });
    const qv = questions.get(questionId)?.version ?? entry?.trial.questionVersion ?? "1";
    const trial = TrialSchema.parse({ ...blockedTrial(questionId, reason, ds, mode, qv, entry), trialId: src.trialId });
    trials.push(trial);
    archives.set(`${questionId}@${qv}`, { trial, runId: src.runId, hasAttempt: true });
  };

  const loadOne = (src: AnswerSource): void => {
    ArchiveName.parse(src.runId);
    ArchiveName.parse(src.trialId);
    if (!plan.has(src.questionId) || seen.has(src.questionId)) throw new Error(`unplanned or duplicate archive question: ${src.questionId}`);
    seen.add(src.questionId);
    if (src.status === "blocked") {
      block(src, src.blockReason ?? "blocked at run time");
      return;
    }
    let entry: ArchivedTrial | undefined;
    try {
      entry = readArchivedTrial(runsRoot, src.runId, src.trialId);
    } catch {
      block(src, "unreadable archive record; execution cannot be ruled out");
      return;
    }
    if (!entry) {
      block(src, "referenced archive is missing; execution cannot be ruled out");
      return;
    }
    const trial = entry.trial;
    const questionId = src.questionId;
    const identityMatches = trial.questionId === questionId && trial.datasetId === datasetId && trial.mode === mode &&
      (!manifest || (trial.datasetVersion === manifest.datasetVersion && trial.provider === manifest.provider &&
        trial.modelId === manifest.modelId && trial.configDigest === manifest.configDigest &&
        (!manifest.promptVersion || trial.promptVersion === manifest.promptVersion) &&
        (!manifest.toolsVersion || trial.toolsVersion === manifest.toolsVersion)));
    if (!identityMatches) {
      block(src, "archive identity does not match manifest", entry);
      return;
    }
    const question = questions.get(questionId);
    if (validationErrors.get(questionId)?.length) {
      block(src, `current question/scoring validation failed: ${validationErrors.get(questionId)!.join("; ")}`, entry);
      return;
    }
    if (!question || question.version !== trial.questionVersion) {
      block(src, "public question missing or version changed", entry);
      return;
    }
    const cur = contentDigests.get(questionId);
    if (!trial.questionContentDigest || !cur) {
      block(src, "content digest missing; cannot confirm the archived question", entry);
      return;
    }
    if (trial.questionContentDigest !== cur) {
      block(src, `question content changed (archived ${trial.questionContentDigest}, current ${cur})`, entry);
      return;
    }
    trials.push(trial);
    locations.set(trial.trialId, { runId: src.runId, trialId: src.trialId });
    archives.set(`${questionId}@${trial.questionVersion}`, entry);
    if (entry.grade) {
      if (entry.grade.trialId !== trial.trialId || entry.grade.questionId !== questionId) throw new Error(`grade identity does not match answer: ${trial.trialId}`);
      grades.push(entry.grade);
    }
  };

  for (const src of manifest?.sources ?? []) loadOne(src);
  const referenced = new Set((manifest?.sources ?? []).map((s) => `${s.runId}/${s.trialId}`));
  const ownDir = join(runsRoot, runId, "trials");
  for (const name of existsSync(ownDir) ? readdirSync(ownDir).sort() : []) {
    if (referenced.has(`${runId}/${name}`)) continue;
    const entry = readArchivedTrial(runsRoot, runId, name);
    if (!entry) continue;
    if (!manifest && entry.trial.mode !== mode) continue;
    loadOne({ questionId: entry.trial.questionId, runId, trialId: name, status: "usable" });
  }

  return { trials, grades, blocked, questions, scorings, plannedQuestionIds, plannedMax, fromManifest: Boolean(manifest), locations, archives };
}
