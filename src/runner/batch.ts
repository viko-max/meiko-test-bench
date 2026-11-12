/**
 * Batch exam runner (AGENTS.md §7/§11/§13). Imports a dataset, runs each
 * confirmed question in the requested mode(s) — ONE answer per (question, model,
 * mode) — grades, persists records + a readable transcript, and builds a
 * per-mode report. Serial by default (v0.2 §14).
 *
 * Invariants enforced here:
 *  - P1-2: both modes receive the SAME native question images; a model that
 *    cannot take a required image is recorded unsupported_input (no call).
 *  - P1-3: NO auto-retry of outcome_unknown (a resend could double-bill and break
 *    "one answer per question"). With --resume, already-completed trials of the
 *    same identity are skipped. Re-answering is a separate explicit action.
 *  - P1-6: grading reads the durable Trial record; transcript rendering is
 *    best-effort post-processing whose failure NEVER marks the trial failed.
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { getSupportedThinkingLevels, type ImageContent } from "@earendil-works/pi-ai";
import type { AnswerMode } from "../shared/contracts.js";
import { ProtectionLimitsSchema, ThinkingLevelSchema, TrialSchema, type ThinkingLevel, type ProtectionLimits, type PublicQuestion, type ScoringSpec, type Trial } from "../shared/contracts.js";
import { importDataset } from "../dataset/import.js";
import { readDatasetVersion } from "../dataset/version.js";
import { createRegistry, resolveModel, type Registry } from "../providers/pi-adapter.js";
import { loadModelsConfig } from "../providers/models-config.js";
import { makeExamStreamFn } from "../providers/stream-fn.js";
import { runOneTrial } from "./trial-service.js";
import type { TaskEvent } from "./task-events.js";
import { loadArchivedTrials, readArchivedTrial, writeGradeFile, countCompletedOtherConfig, answerReusable, type ArchivedTrial } from "./archive.js";
import { classifyArchived } from "./resume.js";
import { mapWithConcurrency } from "./concurrency.js";
import { RequestScheduler, type SchedulerLimits } from "./request-scheduler.js";
import { gradeTrial, gradeIsStale } from "../grading/grade.js";
import { PROMPT_VERSION } from "./prompts.js";
import { buildModeReport, reportToMarkdown, type ModeReport } from "../reporting/report.js";
import { renderTrialTranscript } from "../reporting/transcript.js";
import { buildExamTools, makeToolContext } from "../tools/index.js";
import { readJsonl, pathJoin, ensureDir, writeJsonAtomic } from "../shared/json.js";
import type { Grade } from "../shared/contracts.js";
import { shortDigest } from "../shared/hashing.js";
import { computeConfigDigest, deriveRunId, deriveTrialId } from "../shared/ids.js";
import { loadQuestionImages } from "../dataset/question-images.js";
export { loadQuestionImages } from "../dataset/question-images.js";
import { withExecutionLease, type ExecutionLease } from "./execution-lock.js";
import { loadValidAnswers, readManifest, writeManifest, type AnswerSource, type RunManifest } from "./answer-source.js";
import { EXECUTION_POLICY_VERSION } from "../shared/execution-policy.js";
import { BatchTokenBudget, BatchTokenLimitSchema } from "./batch-budget.js";
import { prepareRecovery, RecoveryDecisionSchema, type RecoveryDecision } from "./recovery.js";

export interface BatchParams {
  batchTokenLimit?: number;
  recoveryDecision?: RecoveryDecision;
  datasetId: string;
  datasetVersion?: string; // real dataset version (P1-3); defaults "1"
  datasetDir: string;
  modes: AnswerMode[];
  profileId: string;
  modelId: string;
  limit: number;
  runsRoot: string;
  workRoot: string;
  toolsVersion: string;
  pythonInterpreter: string;
  modelsConfigPath: string;
  limitsPath?: string;
  limitsOverride?: ProtectionLimits;
  thinkingLevel?: ThinkingLevel;
  requestTimeoutMs?: number;
  resume?: boolean; // (legacy) dedup against archives is now the DEFAULT; kept for compatibility
  /** P1-1: ignore existing answers and re-answer (re-bill) everything. Off by
   *  default — a repeat "start" of the same identity dedups against archives so
   *  completed questions are never re-sent. */
  fresh?: boolean;
  runId?: string; // explicit Run to resume (P1-3); else scan all runs of this identity
  /** Shared-key request scheduler limits (P2-9); per-endpoint gate alongside question concurrency. */
  requestSchedulerLimits?: SchedulerLimits;
  /** Bounded batch concurrency (default 1 = serial, current behavior). >1 runs questions in parallel. */
  concurrency?: number;
  /** Inject a pre-built registry (offline tests); defaults to modelsConfigPath. */
  registryOverride?: Registry;
  onProgress?: (msg: string) => void;
  /** Structured task events (TS-1); TUI/Web consume these instead of parsing logs. */
  onEvent?: (e: TaskEvent) => void;
  /** Stop signal (TS-2): workers stop picking new questions; in-flight agents abort. */
  signal?: AbortSignal;
}

export interface BatchModeResult {
  runId: string;
  report: ModeReport;
  reportMdPath: string;
}

export interface BatchResult {
  byMode: Partial<Record<AnswerMode, BatchModeResult>>;
  plannedMax: number;
  questionCount: number;
}

function loadLimits(path: string | undefined, requestTimeoutMs?: number): ReturnType<typeof ProtectionLimitsSchema.parse> {
  let base: Record<string, unknown> = {};
  if (path) {
    try {
      const positive = z.number().int().positive();
      const j = z.object({ version: z.string().optional(), $comment: z.string().optional(),
        request: z.object({ maxRetries: z.literal(0).optional(), requestTimeoutMs: positive.optional(), maxOutputTokens: positive.optional() }).strict().optional(),
        perTrial: z.object({ totalRunTimeMs: positive.optional(), maxTurns: positive.optional(), maxToolCalls: positive.optional() }).strict().optional(),
        perToolCall: z.object({ timeoutMs: positive.optional(), maxOutputBytes: positive.optional(), maxImagePixels: positive.optional() }).strict().optional(),
      }).strict().parse(JSON.parse(readFileSync(path, "utf8")));
      const req = j.request ?? {};
      const per = j.perTrial ?? {};
      const tool = j.perToolCall ?? {};
      base = {
        requestTimeoutMs: req.requestTimeoutMs,
        maxOutputTokens: req.maxOutputTokens,
        totalRunTimeMs: per.totalRunTimeMs,
        maxTurns: per.maxTurns,
        maxToolCalls: per.maxToolCalls,
        perToolTimeoutMs: tool.timeoutMs,
        maxOutputBytes: tool.maxOutputBytes,
        maxImagePixels: tool.maxImagePixels,
      };
    } catch (error) {
      throw new Error(`保护配置读取或校验失败，不会回退默认值：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return ProtectionLimitsSchema.parse({ ...base, ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}) });
}

// Resume reads durable archives (Trial + Grade + attempt) via loadArchivedTrials; see archive.ts.

export async function runBatch(p: BatchParams): Promise<BatchResult> {
  // 先取得执行权，再读取续跑快照；整个批次及其已启动的并发题目都在保护范围内。
  return withExecutionLease((lease) => runBatchLocked(p, lease));
}

async function runBatchLocked(p: BatchParams, executionLease: ExecutionLease): Promise<BatchResult> {
  if (p.fresh && p.runId) throw new Error("--fresh and --run-id cannot be combined; an existing run must not be silently re-answered");
  const log = p.onProgress ?? (() => {});
  const emit = (e: TaskEvent): void => p.onEvent?.(e);
  const registry: Registry = p.registryOverride ?? createRegistry(loadModelsConfig(p.modelsConfigPath));
  const model = resolveModel(registry, p.profileId, p.modelId);
  if (!model) throw new Error(`model not found: ${p.profileId}:${p.modelId}`);
  const profile = registry.profilesById.get(p.profileId)!;
  const thinkingLevel = ThinkingLevelSchema.parse(p.thinkingLevel ?? "off");
  if (!getSupportedThinkingLevels(model).includes(thinkingLevel)) throw new Error(`model does not support thinking level: ${thinkingLevel}`);
  if (p.modes.length === 0 || new Set(p.modes).size !== p.modes.length) throw new Error("modes must be nonempty and unique");
  if (p.runId && p.modes.length !== 1) throw new Error("explicit resume requires exactly one mode");
  const pinnedManifest = p.runId ? readManifest(p.runsRoot, p.runId) : undefined;
  const batchTokenLimit = p.batchTokenLimit === undefined ? undefined : BatchTokenLimitSchema.parse(p.batchTokenLimit);
  if (pinnedManifest && pinnedManifest.resumeConfig?.batchTokenLimit !== batchTokenLimit) throw new Error("续跑必须保留原批次 Token 预算。");
  if (p.recoveryDecision && (!p.runId || !pinnedManifest)) throw new Error("异常补答必须指定原任务。");
  const recovery = p.recoveryDecision ? RecoveryDecisionSchema.parse(p.recoveryDecision) : undefined;
  const recoverySource = recovery ? await prepareRecovery(p.runsRoot, p.runId!, p.datasetDir, p.datasetId, recovery.questionId) : undefined;
  if (recovery && (recovery.token !== recoverySource!.token || recovery.trialId !== recoverySource!.trialId)) throw new Error("异常记录已变化，请重新检查后决定。");
  if (pinnedManifest && pinnedManifest.executionPolicyVersion !== EXECUTION_POLICY_VERSION) throw new Error("执行保护策略已变化，不能混用历史任务；旧答卷保留可查看。");

  const imported = await importDataset({ datasetId: p.datasetId, publicDir: join(p.datasetDir, "public"), scoringDir: join(p.datasetDir, "scoring") });
  const usableEntries = imported.entries.filter((e) => e.question && e.errors.length === 0);
  if (pinnedManifest && pinnedManifest.plannedQuestionIds.some((id) => !usableEntries.some((e) => e.questionId === id))) {
    throw new Error("requested run plan contains missing or invalid public questions; refusing to dispatch requests");
  }
  const confirmed = pinnedManifest
    ? pinnedManifest.plannedQuestionIds.map((id) => usableEntries.find((e) => e.questionId === id)!)
    : usableEntries.slice(0, p.limit);
  const questions = new Map<string, PublicQuestion>();
  const scorings = new Map<string, ScoringSpec>();
  for (const e of confirmed) {
    questions.set(e.questionId, e.question!);
    if (e.scoring) scorings.set(e.questionId, e.scoring);
  }
  const plannedMax = pinnedManifest?.plannedMaxScore ?? [...scorings.values()].reduce((a, s) => a + s.maxScore, 0);
  if (recoverySource) {
    const current = confirmed.find((entry) => entry.questionId === recoverySource.questionId);
    if (current?.contentDigest !== recoverySource.trial.questionContentDigest || current?.question?.version !== recoverySource.trial.questionVersion) {
      throw new Error("补答材料在检查后发生变化，请重新检查，未发送请求。");
    }
  }
  log(`imported ${confirmed.length} confirmed questions (plannedMax=${plannedMax}); provider=${profile.provider} model=${model.id} imageInput=${profile.capability.imageInput}`);

  const limits = p.limitsOverride ? ProtectionLimitsSchema.parse(p.limitsOverride) : loadLimits(p.limitsPath, p.requestTimeoutMs);
  const scheduler = p.requestSchedulerLimits ? new RequestScheduler(p.requestSchedulerLimits) : undefined; // P2-9 shared-key gate
  const runSuffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const streamFn = makeExamStreamFn(registry.models, { timeoutMs: limits.requestTimeoutMs, maxTokens: limits.maxOutputTokens });
  const publicDir = join(p.datasetDir, "public");
  const toolsFactory = (workDir: string, question: PublicQuestion) =>
    buildExamTools(makeToolContext({ workDir, publicDir, questionFiles: question.assets.map((a) => join(publicDir, a.ref)), pythonInterpreter: p.pythonInterpreter, limits }));

  const result: BatchResult = { byMode: {}, plannedMax, questionCount: confirmed.length };
  let budget: BatchTokenBudget | undefined;
  let budgetRunId = pinnedManifest?.budgetRunId;
  for (const mode of p.modes) {
    let modeRunId = "";
    const trials: Trial[] = [];
    const grades: Grade[] = [];
    const persistGrade = (runId: string, trialId: string, grade: Grade): boolean => {
      try {
        if (readArchivedTrial(p.runsRoot, runId, trialId)?.trial.executionStatus !== "completed") {
          throw new Error("no durable completed answer available for grading");
        }
        writeGradeFile(p.runsRoot, runId, trialId, grade);
        grades.push(grade);
        return true;
      } catch (error) {
        log(`[${mode}] grade persist error (not counted): ${(error as Error).message}`);
        return false;
      }
    };

    // Run-level config digest EXCLUDES the question but INCLUDES the real endpoint
    // (baseUrl), api and resolved model entry (P1-3): the same modelId on a
    // different endpoint/config is a DIFFERENT identity, never mixed.
    const storedVersion = readDatasetVersion(p.datasetDir, p.datasetId);
    if (existsSync(join(p.datasetDir, "VERSION.json")) && p.datasetVersion && p.datasetVersion !== storedVersion) throw new Error("运行版本与已发布题集版本不一致。");
    const datasetVersion = p.datasetVersion ?? storedVersion;
    const configDigest = computeConfigDigest({
      datasetId: p.datasetId,
      datasetVersion,
      provider: profile.provider,
      modelId: model.id,
      mode,
      promptVersion: PROMPT_VERSION,
      toolsVersion: p.toolsVersion,
      baseUrl: profile.baseUrl,
      api: profile.api,
      model: { id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: model.input, reasoning: model.reasoning },
      limits,
      ...(batchTokenLimit === undefined ? {} : { batchTokenLimit }),
      thinkingLevel,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      ...(thinkingLevel !== "off" ? { thinkingConfig: {
        thinkingLevelMap: model.thinkingLevelMap, samplingParams: model.samplingParams,
        samplingParamsByThinkingLevel: model.samplingParamsByThinkingLevel, compat: model.compat,
      } } : {}),
    });
    const contentDigests = new Map(confirmed.map((e) => [`${e.question!.id}@${e.question!.version}`, e.contentDigest]));
    // P1-1: dedup against existing answers is the DEFAULT. A prior "start" of the
    // same identity must NOT re-send (re-bill) completed questions. Only an
    // explicit --fresh ignores the archive (and re-bills) — with a loud warning.
    const dedup = p.fresh !== true;
    let resumeMap: Map<string, ArchivedTrial>;
    if (dedup && p.runId) {
      if (!existsSync(pathJoin(p.runsRoot, p.runId))) throw new Error(`requested run does not exist: ${p.runId}`);
      const priorManifest = readManifest(p.runsRoot, p.runId);
      if (priorManifest && (priorManifest.mode !== mode || priorManifest.provider !== profile.provider ||
        priorManifest.modelId !== model.id || priorManifest.configDigest !== configDigest || priorManifest.datasetVersion !== datasetVersion)) {
        throw new Error("requested run identity/configuration does not match; resume with identical configuration");
      }
      const prior = await loadValidAnswers(p.runsRoot, p.runId, p.datasetDir, p.datasetId, mode);
      if (!priorManifest && [...prior.archives.values()].some((a) => a.trial.provider !== profile.provider || a.trial.modelId !== model.id || a.trial.configDigest !== configDigest)) {
        throw new Error("legacy run identity cannot be confirmed for this configuration; refusing to dispatch requests");
      }
      resumeMap = prior.archives;
      if (!prior.fromManifest && resumeMap.size === 0) throw new Error("requested run has no recoverable identity or attempts; refusing to dispatch requests");
    } else {
      resumeMap = dedup ? loadArchivedTrials(p.runsRoot, mode, profile.provider, model.id, configDigest, undefined, contentDigests) : new Map<string, ArchivedTrial>();
    }
    if (dedup) {
      log(`[${mode}] recognizing existing answers: ${resumeMap.size} archived trial(s) for this identity (completed questions will NOT be re-sent)`);
      const otherCfg = countCompletedOtherConfig(p.runsRoot, mode, profile.provider, model.id, configDigest);
      if (otherCfg > 0) {
        log(`[${mode}] WARNING: ${otherCfg} completed trial(s) for this model/mode exist under a DIFFERENT config (limits/flags); they will NOT resume and will be RE-ANSWERED (re-billed). Pass IDENTICAL flags (incl. --request-timeout-ms) to resume them.`);
      }
    } else {
      log(`[${mode}] FRESH run (--fresh): ignoring existing answers; completed questions WILL be re-answered and RE-BILLED.`);
    }

    const taskRunId = deriveRunId({ datasetId: p.datasetId, datasetVersion, provider: profile.provider, modelId: model.id, configDigest }) + (runSuffix ? `__${runSuffix}` : "");
    // P1-5: persist the run PLAN (identity + planned questions + max) BEFORE any
    // execution, atomically; then update provenance per question so a mid-exit
    // still rebuilds the same scope (never derived from a later-grown dataset).
    const manifest: RunManifest = {
      schema: "pi-exam-run-manifest/1",
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      mode,
      datasetId: p.datasetId,
      datasetVersion,
      provider: profile.provider,
      modelId: model.id,
      configDigest,
      plannedQuestionIds: confirmed.map((e) => e.questionId),
      plannedMaxScore: plannedMax,
      sources: [],
      batchId: runSuffix,
      promptVersion: PROMPT_VERSION,
      toolsVersion: p.toolsVersion,
      resumeConfig: { profileId: p.profileId, thinkingLevel, limits, concurrency: p.concurrency ?? 1,
        ...(batchTokenLimit === undefined ? {} : { batchTokenLimit }),
        pythonInterpreter: p.pythonInterpreter, ...(p.requestSchedulerLimits ? { requestSchedulerLimits: p.requestSchedulerLimits } : {}) },
      ...(recovery ? { recovery: { sourceRunId: p.runId!, questionId: recovery.questionId, trialId: recovery.trialId,
        by: recovery.by, reason: recovery.reason, at: new Date().toISOString() } } : {}),
    };
    const recordSource = (s: AnswerSource): void => {
      manifest.sources.push(s);
      writeManifest(p.runsRoot, taskRunId, manifest);
    };
    // 计划无法持久化时不得继续产生付费请求；来源写入失败也会停止安排新题。
    writeManifest(p.runsRoot, taskRunId, manifest);
    emit({ type: "task_started", runId: taskRunId, mode, datasetId: p.datasetId, provider: profile.provider, modelId: model.id, plannedQuestionIds: confirmed.map((e) => e.questionId),
      at: new Date().toISOString(), concurrency: p.concurrency ?? 1, apiConcurrency: p.requestSchedulerLimits?.maxConcurrent ?? null });
    if (batchTokenLimit !== undefined) {
      if (!budget) {
        if (pinnedManifest && !budgetRunId) throw new Error("原任务缺少批次预算来源，拒绝重置消耗。");
        budgetRunId ??= taskRunId;
        budget = new BatchTokenBudget(join(p.runsRoot, budgetRunId, "budget.json"), batchTokenLimit, !!pinnedManifest,
          (snapshot) => emit({ type: "batch_budget", runId: taskRunId, mode, budget: snapshot }));
      }
      manifest.budgetRunId = budgetRunId;
      budget.setPublisher((snapshot) => emit({ type: "batch_budget", runId: taskRunId, mode, budget: snapshot }));
      writeManifest(p.runsRoot, taskRunId, manifest);
      emit({ type: "batch_budget", runId: taskRunId, mode, budget: budget.snapshot() });
    }
    if (recoverySource) {
      // 已持有全项目执行锁；先消费一次性决定，重复启动在发请求前即被拒绝。
      writeJsonAtomic(recoverySource.marker, { ...manifest.recovery, targetRunId: taskRunId });
    }

    const processOne = async (e: (typeof confirmed)[number], i: number): Promise<void> => {
      if (p.signal?.aborted) {
        emit({ type: "stopped", runId: taskRunId, mode, reason: "stop requested before this question started" });
        return;
      }
      const q = e.question!;
      const previous = resumeMap.get(`${q.id}@${q.version}`);
      const archived = recovery?.questionId === q.id ? undefined : previous;
      if (recovery && recovery.questionId !== q.id && !archived) return;
      if (archived && !answerReusable(archived.trial, e.contentDigest)) {
        // 无法确认内容一致时，既不能复用成绩，也不能自动重新发送请求。
        const reason = `resume blocked: question content changed or digest missing (archived ${archived.trial.questionContentDigest ?? "?"}, current ${e.contentDigest ?? "?"}); explicit decision required`;
        const blocked = TrialSchema.parse({ ...archived.trial, executionStatus: "outcome_unknown", finalAnswerSheet: null, errorMessage: reason });
        trials.push(blocked);
        recordSource({ questionId: q.id, runId: archived.runId, trialId: archived.trial.trialId, status: "blocked", blockReason: reason });
        emit({ type: "question_loaded", runId: taskRunId, mode, questionId: q.id, note: reason, executionStatus: "outcome_unknown" });
        log(`[${mode}] ${q.id} ${reason}`);
        return;
      } else if (archived) {
        const action = recovery && recovery.questionId !== q.id ? "load_decision" : classifyArchived(archived.trial, archived.hasAttempt);
        if (action !== "run") {
          // R1-4 + P1-B: load the archived Trial. A grade is used ONLY if it matches
          // the CURRENT scoring basis. A stale rule grade is re-graded from the
          // archive (and saved); a stale HUMAN grade re-enters review (not counted);
          // a failed re-grade is NOT backfilled with the stale score.
          trials.push(archived.trial);
          recordSource({ questionId: q.id, runId: archived.runId, trialId: archived.trial.trialId, status: "usable" });
          const cur = scorings.get(q.id);
          let gradeNote: string;
          if (archived.grade && cur && gradeIsStale(archived.grade, cur)) {
            if (archived.grade.reviewStatus === "human_confirmed") {
              gradeNote = `human grade v${archived.grade.scoringVersion} is stale (basis now v${cur.scoringVersion}) -> re-review required (NOT counted)`;
            } else {
              const rg = gradeTrial(archived.trial, q, cur);
              if (rg.grade) {
                const saved = persistGrade(archived.runId, archived.trial.trialId, rg.grade);
                gradeNote = saved ? `stale grade re-graded under v${cur.scoringVersion} -> ${rg.grade.reviewStatus} ${rg.grade.rawScore}/${rg.grade.maxScore}` : "grade persist failed -> NOT counted";
              } else {
                gradeNote = `stale grade; re-grade skipped (${rg.skipped}) -> NOT counted`;
              }
            }
          } else if (archived.grade) {
            grades.push(archived.grade); // matches current basis (or no current scoring to compare)
            gradeNote = `loaded ${archived.grade.reviewStatus} ${archived.grade.rawScore}/${archived.grade.maxScore}`;
          } else {
            const rg = gradeTrial(archived.trial, q, cur);
            if (rg.grade) {
              const saved = persistGrade(archived.runId, archived.trial.trialId, rg.grade);
              gradeNote = saved ? `graded from archive ${rg.grade.reviewStatus} ${rg.grade.rawScore}/${rg.grade.maxScore}` : "grade persist failed -> NOT counted";
            } else {
              gradeNote = "no archived grade; not gradable";
            }
          }
          const why = action === "load_completed" ? "already completed" : `needs decision (${archived.trial.executionStatus}) — not auto-resent`;
          log(`[${mode}] (${i + 1}/${confirmed.length}) ${q.id} ${why}; ${gradeNote}`);
          emit({ type: "question_loaded", runId: taskRunId, mode, questionId: q.id, note: gradeNote, executionStatus: archived.trial.executionStatus });
          return;
        }
        log(`[${mode}] (${i + 1}/${confirmed.length}) ${q.id} retrying (previous ${archived.trial.executionStatus}, no call recorded)`);
      }
      if (budget?.snapshot().blocked) {
        emit({ type: "stopped", runId: taskRunId, mode, cause: "batch_token_budget", reason: "批次 Token 额度已用尽、用量未知或预算存档失败；未开始的题保留排队。" });
        return;
      }
      const runSpec = {
        datasetId: p.datasetId,
        datasetVersion,
        questionId: q.id,
        questionVersion: q.version,
        provider: profile.provider,
        modelId: model.id,
        mode,
        promptVersion: PROMPT_VERSION,
        toolsVersion: p.toolsVersion,
        limits,
        ...(thinkingLevel !== "off" ? { thinkingLevel } : {}),
        questionContentDigest: e.contentDigest,
      };
      const recordUnsupported = (reason: string): void => {
        const { limits: _limits, ...identity } = runSpec;
        const trial = TrialSchema.parse({ ...identity, configDigest,
          trialId: deriveTrialId({ ...identity, configDigest }, i), executionStatus: "unsupported_input", executionPolicyVersion: EXECUTION_POLICY_VERSION, terminationCause: "input_rejected", finalAnswerSheet: null, errorMessage: reason });
        writeJsonAtomic(pathJoin(p.runsRoot, taskRunId, "trials", trial.trialId, "trial.json"), trial);
        trials.push(trial);
        recordSource({ questionId: q.id, runId: taskRunId, trialId: trial.trialId, status: "usable" });
        emit({ type: "question_done", runId: taskRunId, mode, questionId: q.id, executionStatus: "unsupported_input", truncated: false, terminationCause: "input_rejected" });
        modeRunId ||= taskRunId;
      };

      // P1-2: native images for both modes; unsupported model -> unsupported_input (no call).
      let images: ImageContent[];
      try {
        images = await loadQuestionImages(q, publicDir);
      } catch (err) {
        recordUnsupported((err as Error).message);
        log(`[${mode}] ${q.id} -> input error (no request sent): ${(err as Error).message}`);
        return;
      }
      if (images.length > 0 && profile.capability.imageInput === "unsupported") {
        recordUnsupported(`model cannot receive required image input (imageInput=${profile.capability.imageInput})`);
        log(`[${mode}] ${q.id} -> unsupported_input (needs ${images.length} image(s))`);
        return;
      }

      log(`[${mode}] (${i + 1}/${confirmed.length}) ${q.id}${images.length ? ` (+${images.length} img)` : ""} …`);
      emit({ type: "question_running", runId: taskRunId, mode, questionId: q.id, index: i, total: confirmed.length, withImages: images.length > 0 });

      // --- model execution (only this is an execution failure) ---
      let res: Awaited<ReturnType<typeof runOneTrial>>;
      try {
        const runIt = () =>
          runOneTrial({
            runSpec,
            question: q,
            index: i,
            streamFn,
            model,
            tools: [],
            toolsFactory: mode === "with_tool" ? toolsFactory : undefined,
            images,
            toolsVersion: p.toolsVersion,
            runsRoot: p.runsRoot,
            workRoot: p.workRoot,
            runIdSuffix: runSuffix,
            configDigest,
            signal: p.signal,
            executionLease,
            batchBudget: budget,
            requestScheduler: scheduler,
            onRequestMetrics: (request) => emit({ type: "request_metrics", runId: taskRunId, mode, questionId: q.id, request }),
            onToolActivity: (tool) => {
              if (tool.running) emit({ type: "tool_running", runId: taskRunId, mode, questionId: q.id, toolName: tool.toolName });
              else emit({ type: "tool", runId: taskRunId, mode, questionId: q.id, toolName: tool.toolName, isError: tool.isError, durationMs: tool.durationMs });
            },
          });
        // P2-9/P1-D: the per-endpoint scheduler gates each request at the streamFn
        // boundary; no coarse per-trial wrapping here.
        res = await runIt();
      } catch (err) {
        // P1-F: runOneTrial stages failures and returns a Trial; reaching here is an
        // UNEXPECTED error. Do NOT fabricate a retryable failed_unprocessed record
        // (that could auto-resend a billed call). Log; resume recovers via attempt.json.
        log(`[${mode}] ${q.id} -> UNEXPECTED_ERROR ${(err as Error).message} (no fabricated record; resume recovers via attempt.json)`);
        throw err; // P2-5b: stop scheduling subsequent questions after an unexpected error
      }

      const { trial, runId: rid, trialId } = res;
      trials.push(trial);
      recordSource({ questionId: q.id, runId: rid, trialId, status: "usable" });
      if (res.archiveError) log(`[${mode}] ${q.id} answered (${trial.executionStatus}) but ARCHIVE WRITE FAILED: ${res.archiveError} — not durably stored; resume will surface outcome_unknown`);
      if (!modeRunId) modeRunId = rid;

      // --- grade from the durable Trial record (independent of transcript) ---
      const g = gradeTrial(trial, q, scorings.get(q.id));
      let savedGrade: Grade | undefined;
      if (g.grade) {
        if (persistGrade(rid, trialId, g.grade)) savedGrade = g.grade;
      }
      log(`[${mode}] ${q.id} -> ${trial.executionStatus}${trial.truncated ? " (truncated)" : ""}${savedGrade ? ` | grade ${savedGrade.reviewStatus} ${savedGrade.rawScore}/${savedGrade.maxScore}` : ` | ${g.skipped ?? "no persisted grade"}`}`);
      emit({ type: "question_done", runId: rid, mode, questionId: q.id, executionStatus: trial.executionStatus, terminationCause: trial.terminationCause, truncated: trial.truncated, metrics: trial.metrics, ...(savedGrade ? { gradingStatus: savedGrade.reviewStatus, rawScore: savedGrade.rawScore, maxScore: savedGrade.maxScore } : {}), ...(res.archiveError ? { archiveError: res.archiveError } : {}) });

      // --- best-effort transcript post-processing (P1-6: never fails the trial) ---
      try {
        const eventsPath = pathJoin(p.runsRoot, rid, "trials", trialId, "events.jsonl");
        const events = readJsonl<{ event: unknown }>(eventsPath).map((r) => r.event);
        const transcript = renderTrialTranscript({
          trialId,
          mode,
          provider: profile.provider,
          modelId: model.id,
          question: q,
          events: events as never,
          answerSheet: trial.finalAnswerSheet,
          executionStatus: trial.executionStatus,
        });
        writeFileSync(pathJoin(p.runsRoot, rid, "trials", trialId, "transcript.md"), transcript, "utf8");
      } catch (err) {
        log(`[${mode}] ${q.id} transcript post-process error (trial + grade unaffected): ${(err as Error).message}`);
      }
    };

    // R3-1: bounded concurrency (default 1 = serial). Each item is one question;
    // per-trial isolation, archives and the report are unchanged.
    try {
      await mapWithConcurrency(confirmed, p.concurrency ?? 1, processOne);
    } catch (err) {
      // P2-5b: a worker's unexpected error stops scheduling; still write the report
      // (un-run planned questions appear as pending).
      log(`[${mode}] scheduler stopped after an error: ${(err as Error).message}`);
    }

    // P1-5: the run's canonical dir is taskRunId (where trials + manifest live);
    // a fully-resumed run writes no new trial but still reports from its manifest.
    const outDir = modeRunId || taskRunId;
    const report = buildModeReport({ mode, provider: profile.provider, trials, grades, questions, scorings, plannedMaxScore: plannedMax, plannedQuestionIds: confirmed.map((e) => e.questionId) });
    // A fully-resumed run may execute nothing; ensure the output dir exists.
    ensureDir(pathJoin(p.runsRoot, outDir));
    const reportMdPath = pathJoin(p.runsRoot, outDir, "report.md");
    writeFileSync(reportMdPath, reportToMarkdown(report), "utf8");
    writeFileSync(pathJoin(p.runsRoot, outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    // Provenance lives in manifest.json (updated per question above); final flush
    // so the manifest matches the finished report exactly.
    writeManifest(p.runsRoot, outDir, manifest);
    result.byMode[mode] = { runId: outDir, report, reportMdPath };
    log(`[${mode}] DONE confirmed=${report.totals.confirmedRaw}/${report.totals.confirmedMax} -> ${reportMdPath}`);
    emit({ type: "mode_done", runId: outDir, mode, confirmedRaw: report.totals.confirmedRaw, confirmedMax: report.totals.confirmedMax, plannedMax: report.totals.plannedMax, at: new Date().toISOString() });
  }

  emit({ type: "task_done", runIds: Object.values(result.byMode).map((m) => m.runId) });
  return result;
}
