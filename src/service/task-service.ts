/**
 * Task control service (TS-3). The single behaviour layer shared by the TUI and a
 * future Web client: start / stop / resume / read-archives / rebuild-report are
 * verifiable service operations. It WRAPS the existing runner (runBatch), archive
 * and reporting modules — it does NOT reimplement a parallel run system.
 *
 * The TUI/Web consume structured TaskEvents + TaskDetail, never parsed log lines,
 * and never re-derive resume or grading logic themselves (AGENTS.md §3).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AnswerMode } from "../shared/contracts.js";
import { GradeSchema, TrialSchema, type Grade, type Trial } from "../shared/contracts.js";
import { runBatch, type BatchParams } from "../runner/batch.js";
import { loadValidAnswers, readManifest } from "../runner/answer-source.js";
import type { TaskEvent } from "../runner/task-events.js";
import { importDataset } from "../dataset/import.js";
import { buildModeReport, type ModeReport } from "../reporting/report.js";
import { taskTelemetry, type TaskTelemetry } from "./task-metrics.js";
import type { TrialMetrics } from "../shared/metrics.js";
import { classifyArchived } from "../runner/resume.js";
import { EXECUTION_POLICY_VERSION } from "../shared/execution-policy.js";
import { prepareRecovery, recoveryContext } from "../runner/recovery.js";
import { BatchTokenBudget, readBudget, reconcileBudget } from "../runner/batch-budget.js";
import { withExecutionLease } from "../runner/execution-lock.js";
import { PROMPT_VERSION } from "../runner/prompts.js";

export interface TaskStartParams extends Omit<BatchParams, "signal" | "onEvent" | "onProgress"> {}

export type TaskState = "running" | "done" | "stopped" | "error" | "budget_paused";

export interface TaskStatus {
  taskId: string;
  state: TaskState;
  runIds: string[];
  events: TaskEvent[];
  error?: string;
  telemetry?: TaskTelemetry;
}

export interface TaskQuestionDetail {
  questionId: string;
  trialId: string;
  executionStatus: string;
  terminationCause?: string;
  truncated: boolean;
  finalAnswerSheet: string | null;
  errorMessage: string | null;
  grade?: Grade;
  gradeHistory: Grade[];
  contentDigest?: string;
  metrics?: TrialMetrics;
}

export interface TaskDetail {
  runId: string;
  questions: TaskQuestionDetail[];
  report?: ModeReport;
}

export interface TaskSummary {
  runId: string;
  hasReport: boolean;
  trialCount: number;
  startedAt?: string;
  historyIssue?: string;
}

interface TaskRecord {
  taskId: string;
  controller: AbortController;
  state: TaskState;
  events: TaskEvent[];
  subscribers: Set<(e: TaskEvent) => void>;
  runIds: string[];
  error?: string;
  done: Promise<void>;
  endedAt?: number;
}

export class TaskControlService {
  async getExceptions(runsRoot: string, runId: string, datasetDir: string, datasetId: string) {
    const manifest = readManifest(runsRoot, runId);
    if (!manifest) throw new Error("任务缺少计划，无法列出未开始的题。");
    const detail = await this.getValidatedTaskDetail(runsRoot, runId, datasetDir, datasetId, manifest.mode);
    const context = await recoveryContext(runsRoot, runId, datasetDir, datasetId);
    const budget = manifest.budgetRunId ? readBudget(join(runsRoot, manifest.budgetRunId, "budget.json")) : undefined;
    const items = await Promise.all(manifest.plannedQuestionIds.map(async (questionId) => {
      const question = detail.questions.find((q) => q.questionId === questionId);
      if (question?.executionStatus === "completed" && !budget?.entries.some((e) => e.questionId === questionId && e.state !== "known")) return undefined;
      let recovery: Awaited<ReturnType<typeof prepareRecovery>> | undefined;
      let blockedReason = "未开始的题使用续跑；不支持的输入需要先检查材料或模型。";
      if (question) {
        try { recovery = context.prepare(questionId); }
        catch (error) { blockedReason = error instanceof Error ? error.message : String(error); }
      }
      return { questionId, question, recovery, blockedReason };
    }));
    return { items: items.filter((item): item is NonNullable<typeof item> => item !== undefined), budget };
  }

  async reconcileUsage(runsRoot: string, runId: string, requestId: string, total: number, by: string, reason: string): Promise<void> {
    await withExecutionLease(async () => {
      const manifest = readManifest(runsRoot, runId);
      if (!manifest?.budgetRunId || !manifest.resumeConfig?.batchTokenLimit) throw new Error("任务没有预算记录。");
      // 获取独占执行权后，遗留 active 请求才能判为未知；核对只调整记账，不重发请求。
      const path = join(runsRoot, manifest.budgetRunId, "budget.json");
      new BatchTokenBudget(path, manifest.resumeConfig.batchTokenLimit, true);
      reconcileBudget(path, requestId, total, by, reason);
    });
  }
  /** 只预览保存的单模式计划；未知结果保留，未执行题才进入续跑范围。 */
  async prepareResume(runsRoot: string, runId: string, datasetDir: string, datasetId: string) {
    const manifest = readManifest(runsRoot, runId);
    if (!manifest?.resumeConfig || !manifest.toolsVersion || !manifest.promptVersion) {
      throw new Error("该历史任务缺少可还原的配置快照，不能从界面安全续跑；仍可查看答卷和重算报告。");
    }
    if (manifest.promptVersion !== PROMPT_VERSION) throw new Error("题面呈现与提示词版本已变化，旧任务不能按新版本续跑；已有答卷仍可查看和复核。");
    if (manifest.executionPolicyVersion !== EXECUTION_POLICY_VERSION) throw new Error("执行保护策略已变化，旧任务不能按新策略续跑；答卷和报告仍可查看。");
    const answers = await loadValidAnswers(runsRoot, runId, datasetDir, datasetId, manifest.mode);
    let queued = 0, retained = 0, blocked = 0;
    for (const id of answers.plannedQuestionIds) {
      const q = answers.questions.get(id);
      if (!q) throw new Error(`原计划题目不存在：${id}`);
      const archive = answers.archives.get(`${id}@${q.version}`);
      const action = archive ? classifyArchived(archive.trial, archive.hasAttempt) : "run";
      if (action === "run") queued++;
      else if (action === "load_decision") blocked++;
      else retained++;
    }
    return { runId, manifest, config: manifest.resumeConfig, queued, retained, blocked };
  }
  private readonly tasks = new Map<string, TaskRecord>();
  private seq = 0;

  resolveRunMode(runsRoot: string, runId: string, requested?: AnswerMode): { runId: string; mode: AnswerMode } {
    const manifest = readManifest(runsRoot, runId);
    const actual = manifest?.mode ?? this.getTaskDetail(runsRoot, runId).report?.mode;
    const mode = requested ?? actual;
    if (!mode) throw new Error("该任务缺少模式记录，无法确定要查看的成绩。");
    if (!actual || actual === mode) return { runId, mode };
    // 模式关联来自保存的同一批次，不能用进程中最近一次任务覆盖历史选择。
    const siblings = manifest?.batchId ? readdirSync(runsRoot).filter((name) => {
      const other = readManifest(runsRoot, name);
      return !!other && other.batchId === manifest.batchId && other.mode === mode && other.datasetId === manifest.datasetId &&
        other.datasetVersion === manifest.datasetVersion && other.provider === manifest.provider && other.modelId === manifest.modelId;
    }) : [];
    if (siblings.length !== 1) throw new Error("该任务没有唯一关联的另一模式记录，请从历史列表选择对应任务。");
    return { runId: siblings[0]!, mode };
  }

  /** Start a batch task in the background. Returns a taskId immediately; resume
   *  dedupes already-completed questions, so a redraw/duplicate never re-answers. */
  start(params: TaskStartParams): string {
    const taskId = `task-${Date.now().toString(36)}-${this.seq++}`;
    const controller = new AbortController();
    const rec: TaskRecord = { taskId, controller, state: "running", events: [], subscribers: new Set(), runIds: [], done: Promise.resolve() };
    this.tasks.set(taskId, rec);
    const onEvent = (e: TaskEvent): void => {
      rec.events.push(e);
      for (const cb of rec.subscribers) cb(e);
    };
    rec.done = runBatch({ ...params, signal: controller.signal, onEvent, onProgress: () => {} })
      .then((result) => {
        rec.runIds = Object.values(result.byMode).map((m) => m.runId);
        const budgetPaused = rec.events.some((e) => (e.type === "stopped" && e.cause === "batch_token_budget") ||
          (e.type === "question_done" && e.terminationCause === "batch_token_budget"));
        rec.state = controller.signal.aborted ? "stopped" : budgetPaused ? "budget_paused" : "done";
        rec.endedAt = Date.now();
      })
      .catch((err) => {
        rec.state = "error";
        rec.error = (err as Error).message;
        rec.endedAt = Date.now();
      });
    return taskId;
  }

  /** Signal stop: workers stop picking new questions; in-flight agents abort. */
  stop(taskId: string): void {
    const rec = this.tasks.get(taskId);
    if (rec && rec.state === "running") {
      rec.controller.abort();
      rec.state = "stopped";
    }
  }

  getStatus(taskId: string): TaskStatus | undefined {
    const rec = this.tasks.get(taskId);
    if (!rec) return undefined;
    return { taskId, state: rec.state, runIds: rec.runIds, events: rec.events, telemetry: taskTelemetry(rec.events, rec.endedAt ?? Date.now()), ...(rec.error ? { error: rec.error } : {}) };
  }

  /** Subscribe to live events; returns an unsubscribe fn. */
  subscribe(taskId: string, cb: (e: TaskEvent) => void): () => void {
    const rec = this.tasks.get(taskId);
    if (!rec) return () => {};
    rec.subscribers.add(cb);
    return () => rec.subscribers.delete(cb);
  }

  /** Await task completion (for tests / scripting). */
  async whenDone(taskId: string): Promise<TaskStatus | undefined> {
    const rec = this.tasks.get(taskId);
    if (!rec) return undefined;
    await rec.done;
    return this.getStatus(taskId);
  }

  /** List historical run dirs on disk (survives restart, no process memory). */
  listTasks(runsRoot: string): TaskSummary[] {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(runsRoot);
    } catch {
      return [];
    }
    const out: TaskSummary[] = [];
    for (const dir of dirs.sort()) {
      const trialsDir = join(runsRoot, dir, "trials");
      if (!existsSync(trialsDir) && !readManifest(runsRoot, dir) && !existsSync(join(runsRoot, dir, "report.json"))) continue;
      let trialCount = 0;
      try {
        trialCount = readdirSync(trialsDir).length;
      } catch {
        /* ignore */
      }
      const metadataPath = join(runsRoot, dir, "run.json");
      let startedAt: string | undefined;
      let historyIssue: string | undefined;
      if (existsSync(metadataPath)) {
        try {
          const metadata = z.object({ startedAt: z.string().datetime({ offset: true }) }).passthrough()
            .safeParse(JSON.parse(readFileSync(metadataPath, "utf8")));
          if (metadata.success) startedAt = metadata.data.startedAt;
          else historyIssue = "任务开始时间缺失或无效";
        } catch { historyIssue = "任务时间记录无法读取"; }
      } else historyIssue = "未记录任务开始时间";
      out.push({ runId: dir, hasReport: existsSync(join(runsRoot, dir, "report.json")), trialCount,
        ...(startedAt ? { startedAt } : {}), ...(historyIssue ? { historyIssue } : {}) });
    }
    // 报告会因离线复核更新，不能用文件修改时间把旧任务排到最近。
    return out.sort((a, b) => {
      if (!a.startedAt && b.startedAt) return 1;
      if (a.startedAt && !b.startedAt) return -1;
      const order = a.startedAt && b.startedAt ? Date.parse(b.startedAt) - Date.parse(a.startedAt) : 0;
      return order || a.runId.localeCompare(b.runId);
    });
  }

  /** Read a task's per-question detail from its archives (survives restart). */
  getTaskDetail(runsRoot: string, runId: string): TaskDetail {
    const trialsDir = join(runsRoot, runId, "trials");
    const questions: TaskQuestionDetail[] = [];
    let trialDirs: string[] = [];
    try {
      trialDirs = readdirSync(trialsDir);
    } catch {
      trialDirs = [];
    }
    for (const t of trialDirs.sort()) {
      const tp = join(trialsDir, t, "trial.json");
      if (!existsSync(tp)) continue;
      let trial: Trial;
      try {
        trial = TrialSchema.parse(JSON.parse(readFileSync(tp, "utf8")));
      } catch {
        continue;
      }
      const gp = join(trialsDir, t, "grade.json");
      let grade: Grade | undefined;
      if (existsSync(gp)) {
        try {
          grade = GradeSchema.parse(JSON.parse(readFileSync(gp, "utf8")));
        } catch {
          /* ignore */
        }
      }
      questions.push({
        questionId: trial.questionId,
        trialId: trial.trialId,
        executionStatus: trial.executionStatus,
        terminationCause: trial.terminationCause,
        truncated: trial.truncated,
        finalAnswerSheet: trial.finalAnswerSheet,
        errorMessage: trial.errorMessage,
        metrics: trial.metrics,
        ...(grade ? { grade } : {}),
        gradeHistory: readGradeHistory(join(trialsDir, t, "grade-history.jsonl")),
        ...(trial.questionContentDigest ? { contentDigest: trial.questionContentDigest } : {}),
      });
    }
    const reportPath = join(runsRoot, runId, "report.json");
    const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, "utf8")) as ModeReport) : undefined;
    return { runId, questions, ...(report ? { report } : {}) };
  }

  /** Rebuild a report purely from a task's archives + the current dataset (never
   *  re-answers). Returns the rebuilt report. */
  async rebuildReport(runsRoot: string, runId: string, datasetDir: string, datasetId: string, mode: AnswerMode): Promise<ModeReport> {
    // P1-1/3/5: use the ONE canonical valid-answer loader — it re-verifies run
    // identity, question version AND content digest against the CURRENT dataset,
    // surfaces blocked answers as outcome_unknown (never counted, never dropped),
    // and rebuilds strictly from the run's saved plan.
    const va = await loadValidAnswers(runsRoot, runId, datasetDir, datasetId, mode);
    return buildModeReport({
      mode,
      trials: va.trials,
      grades: va.grades,
      questions: va.questions,
      scorings: va.scorings,
      plannedMaxScore: va.plannedMax,
      plannedQuestionIds: va.plannedQuestionIds,
    });
  }

  /** 交互页面与报告读取同一组有效答卷，包括此前任务的来源记录。 */
  async getValidatedTaskDetail(runsRoot: string, runId: string, datasetDir: string, datasetId: string, mode: AnswerMode): Promise<TaskDetail> {
    const va = await loadValidAnswers(runsRoot, runId, datasetDir, datasetId, mode);
    const grades = new Map(va.grades.map((grade) => [grade.trialId, grade]));
    const questions = va.trials.map((trial): TaskQuestionDetail => {
      const location = va.locations.get(trial.trialId);
      const grade = grades.get(trial.trialId);
      return {
        questionId: trial.questionId, trialId: trial.trialId, executionStatus: trial.executionStatus,
        terminationCause: trial.terminationCause,
        truncated: trial.truncated, finalAnswerSheet: trial.finalAnswerSheet, errorMessage: trial.errorMessage,
        metrics: trial.metrics,
        ...(grade ? { grade } : {}),
        gradeHistory: location ? readGradeHistory(join(runsRoot, location.runId, "trials", location.trialId, "grade-history.jsonl")) : [],
        ...(trial.questionContentDigest ? { contentDigest: trial.questionContentDigest } : {}),
      };
    });
    const report = buildModeReport({ mode, trials: va.trials, grades: va.grades, questions: va.questions,
      scorings: va.scorings, plannedMaxScore: va.plannedMax, plannedQuestionIds: va.plannedQuestionIds });
    return { runId, questions, report };
  }
}

function readGradeHistory(path: string): Grade[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return GradeSchema.parse((JSON.parse(l) as { grade: unknown }).grade);
        } catch {
          return undefined;
        }
      })
      .filter((g): g is Grade => g !== undefined);
  } catch {
    return [];
  }
}
