/**
 * Orchestrate ONE exam attempt end-to-end (AGENTS.md §7/§11): derive the trial
 * identity, create the isolated per-attempt .work dir, wire the Agent
 * (mode-appropriate tools scoped to THIS question), run, and persist an atomic
 * Trial record + append-only events. The caller supplies the streamFn + model
 * (real registry in production, faux in tests) and the tool factory.
 *
 * P1-F: failures are STAGED and this function does not throw for exam logic —
 *  - before a request is sent (work-dir / agent build) -> failed_unprocessed (retryable)
 *  - after a request is sent -> the real outcome (runTrial maps it; never a blanket
 *    failed_unprocessed, which would trigger an auto-resend of a billed call)
 *  - answer obtained but the archive write failed -> the Trial (real status) is
 *    still returned with `archiveError`; it is NOT durably stored, so resume
 *    surfaces it as outcome_unknown via attempt.json. The Trial id is stable and
 *    never fabricated in an exception branch.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { TrialSchema, type ExecutionStatus, type PublicQuestion, type RunSpec, type Trial } from "../shared/contracts.js";
import { deriveRunId, deriveTrialId } from "../shared/ids.js";
import { shortDigest } from "../shared/hashing.js";
import { writeJsonAtomic } from "../shared/json.js";
import { RunStore } from "../storage/run-store.js";
import type { TrialRecorder } from "../storage/recorder.js";
import { buildAgent } from "./agent-factory.js";
import { LimitGuard } from "./limits.js";
import { buildSystemPrompt } from "./prompts.js";
import { runTrial } from "./run-trial.js";
import { assertExecutionLease, withExecutionLease, type ExecutionLease } from "./execution-lock.js";
import { RequestMetricsCollector } from "./request-metrics.js";
import type { RequestMetrics } from "../shared/metrics.js";
import { EXECUTION_POLICY_VERSION } from "../shared/execution-policy.js";
import type { BatchTokenBudget } from "./batch-budget.js";
import type { RequestScheduler } from "./request-scheduler.js";
import { scheduledStreamFn } from "../providers/stream-fn.js";

export interface RunOneTrialParams {
  batchBudget?: BatchTokenBudget;
  requestScheduler?: RequestScheduler;
  runSpec: RunSpec;
  question: PublicQuestion;
  index: number;
  streamFn: StreamFn;
  model: Model<Api>;
  tools: AgentTool[];
  toolsFactory?: (workDir: string, question: PublicQuestion) => AgentTool[];
  images?: ImageContent[];
  toolsVersion: string;
  runsRoot: string;
  workRoot: string;
  recorder?: TrialRecorder; // override for tests (defaults to durable RunStore)
  /** Override the durable trial.json write (tests); defaults to RunStore. */
  persistTrial?: (trial: Trial) => void;
  runIdSuffix?: string; // distinct run dir per batch invocation (history preserved)
  configDigest?: string; // batch passes an endpoint/model-enriched digest (P1-3); else derived from runSpec
  signal?: AbortSignal; // stop signal (TS-2): abort the in-flight agent/tools
  now?: () => string;
  /** 批量入口传递有效执行权；直接调用单题入口时自行获取，禁止伪造或复用已释放的对象。 */
  executionLease?: ExecutionLease;
  onRequestMetrics?: (metric: RequestMetrics) => void;
  onToolActivity?: (tool: { toolName: string; running: boolean; isError: boolean; durationMs?: number }) => void;
}

export interface RunOneTrialResult {
  trial: Trial;
  runId: string;
  trialId: string;
  workDir: string;
  /** Set when a durable archive write failed AFTER the attempt ran: the Trial
   *  (real status) is returned for the report but is NOT durably stored. */
  archiveError?: string;
}

export async function runOneTrial(p: RunOneTrialParams): Promise<RunOneTrialResult> {
  if (p.executionLease) {
    assertExecutionLease(p.executionLease);
    return runOneTrialLocked(p);
  }
  return withExecutionLease(() => runOneTrialLocked(p));
}

async function runOneTrialLocked(p: RunOneTrialParams): Promise<RunOneTrialResult> {
  const now = p.now ?? (() => new Date().toISOString());
  // Run-level config digest EXCLUDES the question, so all questions in a batch
  // share one runId; the question is part of the per-trial identity instead.
  let configDigest: string;
  if (p.configDigest) {
    configDigest = p.configDigest;
  } else {
    const { questionId: _qid, questionVersion: _qv, thinkingLevel, ...runLevel } = p.runSpec;
    const policy = { ...runLevel, executionPolicyVersion: EXECUTION_POLICY_VERSION };
    configDigest = shortDigest(thinkingLevel && thinkingLevel !== "off" ? { ...policy, thinkingLevel } : policy);
  }
  const runId =
    deriveRunId({
      datasetId: p.runSpec.datasetId,
      datasetVersion: p.runSpec.datasetVersion,
      provider: p.runSpec.provider,
      modelId: p.runSpec.modelId,
      configDigest,
    }) + (p.runIdSuffix ? `__${p.runIdSuffix}` : "");
  const trialId = deriveTrialId(
    {
      datasetId: p.runSpec.datasetId,
      datasetVersion: p.runSpec.datasetVersion,
      questionId: p.runSpec.questionId,
      questionVersion: p.runSpec.questionVersion,
      provider: p.runSpec.provider,
      modelId: p.runSpec.modelId,
      mode: p.runSpec.mode,
      configDigest,
      promptVersion: p.runSpec.promptVersion,
      toolsVersion: p.toolsVersion,
      questionContentDigest: p.runSpec.questionContentDigest,
    },
    p.index,
  );

  const startedAt = now();
  let metricsRecorder: TrialRecorder | undefined;
  let metricsArchiveError: string | undefined;
  const recordMetrics = (event: unknown) => {
    try { metricsRecorder?.recordEvent(event); }
    catch (error) { metricsArchiveError = `metrics log persist failed: ${error instanceof Error ? error.message : String(error)}`; }
  };
  const metrics = new RequestMetricsCollector((metric) => {
    recordMetrics({ type: "request_metrics", request: metric });
    p.onRequestMetrics?.(metric);
  });
  const mkTrial = (executionStatus: ExecutionStatus, extra: Partial<Trial> = {}): Trial =>
    TrialSchema.parse({
      trialId,
      datasetId: p.runSpec.datasetId,
      datasetVersion: p.runSpec.datasetVersion,
      questionId: p.runSpec.questionId,
      questionVersion: p.runSpec.questionVersion,
      provider: p.runSpec.provider,
      modelId: p.runSpec.modelId,
      mode: p.runSpec.mode,
      configDigest,
      promptVersion: p.runSpec.promptVersion,
      toolsVersion: p.toolsVersion,
      executionStatus,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      truncated: false,
      finalAnswerSheet: null,
      gradingStatus: "ungraded",
      startedAt,
      endedAt: now(),
      metrics: metrics.snapshot(),
      thinkingLevel: p.runSpec.thinkingLevel,
      questionContentDigest: p.runSpec.questionContentDigest,
      ...extra,
    });

  const workDir = join(p.workRoot, runId, trialId);

  let dispatched = false;
  try {
    const store = new RunStore(p.runsRoot, runId); // inside the guard: infra failure is staged
    const recorder = p.recorder ?? store.recorderFor(trialId);
    metricsRecorder = recorder;

    // --- stage 0: isolated work dir (pre-call) ---
    mkdirSync(workDir, { recursive: true });

    // --- stage 1: build the agent + record the attempt BEFORE dispatch (pre-call) ---
    const guard = new LimitGuard(p.runSpec.limits);
    const effectiveTools = p.runSpec.mode === "with_tool" ? (p.toolsFactory ? p.toolsFactory(workDir, p.question) : p.tools) : [];
    const systemPrompt = buildSystemPrompt(p.runSpec.mode, effectiveTools.map((t) => t.name));
    const budgetedStream = p.batchBudget ? p.batchBudget.wrap(p.streamFn, { runId, trialId, questionId: p.question.id }, () => guard.stop("batch_token_budget")) : p.streamFn;
    // 每一轮都先取得 API 名额，再检查并预留预算；等待中的请求不能越过未知用量暂停。
    const scheduledStream = p.requestScheduler ? scheduledStreamFn(budgetedStream, p.requestScheduler, (model) => model.baseUrl) : budgetedStream;
    const recordedStream = metrics.wrap(scheduledStream);
    const agent = buildAgent({ streamFn: recordedStream, systemPrompt, model: p.model, tools: effectiveTools, mode: p.runSpec.mode, limits: p.runSpec.limits, guard, recorder,
      thinkingLevel: p.runSpec.thinkingLevel, onThinkingLevel: (level) => metrics.setThinkingLevel(level) });
    if (!p.recorder) {
      writeJsonAtomic(join(store.trialDir(trialId), "attempt.json"), {
        trialId, runId, datasetId: p.runSpec.datasetId, datasetVersion: p.runSpec.datasetVersion, questionId: p.runSpec.questionId,
        questionVersion: p.runSpec.questionVersion, provider: p.runSpec.provider, modelId: p.runSpec.modelId, mode: p.runSpec.mode,
        configDigest, promptVersion: p.runSpec.promptVersion, toolsVersion: p.toolsVersion, status: "dispatched", startedAt,
        questionContentDigest: p.runSpec.questionContentDigest,
      });
    }
    dispatched = true;

    // --- stage 2: the model call (runTrial never throws) ---
    const toolStarts = new Map<string, number>();
    const outcome = await runTrial({ agent, question: p.question, guard, recorder, images: p.images, signal: p.signal, includeAssetRefs: p.runSpec.mode === "with_tool", onEvent: (event) => {
      if (event.type === "tool_execution_start") {
        metrics.toolCalls++;
        toolStarts.set(event.toolCallId, performance.now());
        p.onToolActivity?.({ toolName: event.toolName, running: true, isError: false });
      } else if (event.type === "tool_execution_end") {
        if (event.isError) metrics.toolErrors++;
        const start = toolStarts.get(event.toolCallId);
        p.onToolActivity?.({ toolName: event.toolName, running: false, isError: event.isError,
          ...(start === undefined ? {} : { durationMs: performance.now() - start }) });
      }
    } });
    const recordedMetrics = metrics.snapshot();
    recordMetrics({ type: "trial_metrics", metrics: recordedMetrics });
    const endedAt = now();
    const trial = TrialSchema.parse({
      trialId, datasetId: p.runSpec.datasetId, datasetVersion: p.runSpec.datasetVersion, questionId: p.runSpec.questionId,
      questionVersion: p.runSpec.questionVersion, provider: p.runSpec.provider, modelId: p.runSpec.modelId, mode: p.runSpec.mode,
      configDigest, promptVersion: p.runSpec.promptVersion, toolsVersion: p.toolsVersion, executionStatus: outcome.executionStatus as ExecutionStatus,
      truncated: outcome.truncated, finalAnswerSheet: outcome.finalAnswerSheet, stopReason: outcome.stopReason, errorMessage: outcome.errorMessage,
      terminationCause: outcome.terminationCause,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      gradingStatus: "ungraded", startedAt, endedAt, questionContentDigest: p.runSpec.questionContentDigest,
      metrics: recordedMetrics,
      thinkingLevel: p.runSpec.thinkingLevel,
    });

    // --- stage 3: archive (best-effort; failure surfaced, never thrown/mislabeled) ---
    let archiveError: string | undefined = metricsArchiveError;
    if (!p.recorder) {
      try {
        store.writeRunSnapshot({ runId, configDigest, promptVersion: p.runSpec.promptVersion, toolsVersion: p.toolsVersion, executionPolicyVersion: EXECUTION_POLICY_VERSION, startedAt });
        if (p.persistTrial) p.persistTrial(trial);
        else writeJsonAtomic(join(store.trialDir(trialId), "trial.json"), trial);
        writeJsonAtomic(join(store.trialDir(trialId), "attempt.json"), {
          trialId, runId, datasetId: p.runSpec.datasetId, datasetVersion: p.runSpec.datasetVersion, questionId: p.runSpec.questionId,
          questionVersion: p.runSpec.questionVersion, provider: p.runSpec.provider, modelId: p.runSpec.modelId, mode: p.runSpec.mode,
          configDigest, promptVersion: p.runSpec.promptVersion, toolsVersion: p.toolsVersion, status: trial.executionStatus, startedAt, endedAt,
          questionContentDigest: p.runSpec.questionContentDigest,
        });
      } catch (e) {
        archiveError = [archiveError, (e as Error).message].filter(Boolean).join("; "); // 答卷已获得，存档错误单独报告。
      }
    }
    if (outcome.answerSheetError) {
      archiveError = archiveError ? `${archiveError}; answer-sheet: ${outcome.answerSheetError}` : `answer-sheet persist failed: ${outcome.answerSheetError}`;
    }
    return { trial, runId, trialId, workDir, ...(archiveError ? { archiveError } : {}) };
  } catch (e) {
    // Unexpected error. If a request was dispatched -> outcome unknown (never a
    // retryable failed_unprocessed that could re-bill); else failed_unprocessed.
    const status: ExecutionStatus = dispatched ? "outcome_unknown" : "failed_unprocessed";
    return { trial: mkTrial(status, { errorMessage: (e as Error).message }), runId, trialId, workDir };
  }
}
