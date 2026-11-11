/**
 * Archive access for resume + report regeneration (AGENTS.md §2/§7; v0.2 §11).
 * The durable Trial/Grade/attempt records are the single source of truth: a
 * resumed run LOADS archived trials + grades so its report reflects old + new,
 * and re-grading reads archived answer sheets only — never re-answers.
 *
 * 恢复按运行身份、题目版本和内容摘要选择记录；内容无法确认时阻止自动发送。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { GradeSchema, TrialSchema, type AnswerMode, type Grade, type Trial } from "../shared/contracts.js";
import { appendJsonl, pathJoin, writeJsonAtomic } from "../shared/json.js";

export interface ArchivedTrial {
  trial: Trial;
  grade?: Grade;
  /** An attempt.json exists => a model request was dispatched for this trial. */
  hasAttempt: boolean;
  /** The run dir this trial was found in (for writing re-grades back). */
  runId: string;
}

/** Persist a Grade next to its Trial (durable; report regenerates from these). */
export function writeGradeFile(runsRoot: string, runId: string, trialId: string, grade: Grade): void {
  const validated = GradeSchema.parse(grade);
  const dir = pathJoin(runsRoot, runId, "trials", trialId);
  const path = pathJoin(dir, "grade.json");
  if (existsSync(path)) {
    // 旧评分读取或历史写入失败时立即退出，保留当前评分。
    const previous = GradeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (JSON.stringify(previous) === JSON.stringify(validated)) return;
    appendJsonl(pathJoin(dir, "grade-history.jsonl"), { at: new Date().toISOString(), grade: previous });
  }
  writeJsonAtomic(path, validated);
}

const AttemptRecordSchema = z.object({
  trialId: z.string().min(1), runId: z.string().min(1),
  datasetId: z.string().min(1), datasetVersion: z.string().min(1),
  questionId: z.string().min(1), questionVersion: z.string().min(1),
  provider: z.string().min(1), modelId: z.string().min(1),
  mode: z.enum(["without_tool", "with_tool"]), configDigest: z.string().min(1),
  promptVersion: z.string().min(1), toolsVersion: z.string().min(1),
  status: z.string().min(1), startedAt: z.string().min(1), questionContentDigest: z.string().optional(),
});

export function readArchivedTrial(runsRoot: string, runId: string, trialId: string): ArchivedTrial | undefined {
  const dir = pathJoin(runsRoot, runId, "trials", trialId);
  const tp = pathJoin(dir, "trial.json");
  const ap = pathJoin(dir, "attempt.json");
  const hasAttempt = existsSync(ap);
  const raw = tryReadJson<Trial>(tp);
  const parsed = TrialSchema.safeParse(raw);
  let trial: Trial;
  if (parsed.success) {
    trial = parsed.data;
  } else if (hasAttempt) {
    // 请求记录损坏时无法证明没有发送，必须阻止继续执行，不能把它当作不存在。
    const attempt = AttemptRecordSchema.parse(JSON.parse(readFileSync(ap, "utf8")));
    if (attempt.runId !== runId || attempt.trialId !== trialId) throw new Error(`attempt identity does not match archive location: ${runId}/${trialId}`);
    const { runId: _runId, status: _status, ...identity } = attempt;
    trial = TrialSchema.parse({ ...identity, executionStatus: "outcome_unknown", finalAnswerSheet: null,
      errorMessage: "attempt dispatched but no valid trial record (outcome unknown; not auto-resent)" });
  } else {
    // No valid trial.json AND no attempt.json: nothing proves a request was
    // dispatched, so this is not resumable — treat as absent (the batch may run
    // it fresh). (An attempt.json present -> the branch above blocks re-runs as
    // outcome_unknown.) Throwing here would crash the whole batch on one file.
    return undefined;
  }
  if (trial.trialId !== trialId) throw new Error(`trial identity does not match archive location: ${runId}/${trialId}`);
  const grade = GradeSchema.safeParse(tryReadJson<Grade>(pathJoin(dir, "grade.json")));
  return { trial, hasAttempt, runId, ...(grade.success && trial.executionStatus === "completed" ? { grade: grade.data } : {}) };
}

function tryReadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Load archived trials for one answering identity (mode+provider+model+
 * configDigest), keyed by `questionId@questionVersion`, each with its archived
 * Grade and whether an attempt was dispatched. A dispatched-but-unrecorded
 * attempt (attempt.json, no trial.json) is surfaced as outcome_unknown so a
 * possibly-billed answer is NEVER silently re-sent.
 */
export function loadArchivedTrials(
  runsRoot: string,
  mode: AnswerMode,
  provider: string,
  modelId: string,
  configDigest: string,
  runIdFilter?: string,
  contentDigests?: ReadonlyMap<string, string | undefined>,
): Map<string, ArchivedTrial> {
  const out = new Map<string, ArchivedTrial>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(runsRoot).sort();
  } catch {
    return out;
  }
  const matches = (m: AnswerMode, p: string, mid: string, cd: string) => m === mode && p === provider && mid === modelId && cd === configDigest;

  for (const dir of dirs) {
    if (runIdFilter && dir !== runIdFilter) continue; // explicit --run-id: only this run
    const td = pathJoin(runsRoot, dir, "trials");
    if (!existsSync(td)) continue;
    let ts: string[] = [];
    try {
      ts = readdirSync(td);
    } catch {
      continue;
    }
    for (const t of ts) {
      const entry = readArchivedTrial(runsRoot, dir, t);
      if (!entry) continue;
      const tr = entry.trial;
      if (!matches(tr.mode, tr.provider, tr.modelId, tr.configDigest)) continue;

      const key = `${entry.trial.questionId}@${entry.trial.questionVersion}`;
      const prev = out.get(key);
      // 先按当前内容选择候选；其他内容的完成记录不能覆盖匹配的中断记录。
      const rank = (a: ArchivedTrial): number => {
        const digest = contentDigests?.get(key);
        const contentRank = !contentDigests ? 0 : answerReusable(a.trial, digest) ? 100 : !a.trial.questionContentDigest ? 50 : 0;
        return contentRank + (a.trial.executionStatus === "completed" ? 10 : 0);
      };
      if (!prev || rank(entry) > rank(prev)) {
        out.set(key, entry);
      }
    }
  }
  return out;
}

/**
 * Count COMPLETED trials for this model/mode that live under a DIFFERENT
 * configDigest. On --resume, a >0 count means a limits/flag difference (e.g. a
 * forgotten --request-timeout-ms) would silently RE-ANSWER and RE-BILL those
 * questions instead of resuming them — the caller warns loudly.
 */
/** An archived answer is reusable on resume ONLY if the question CONTENT is
 *  unchanged (P1-1b): a same-version content edit must NOT reuse the old answer.
 *  If either digest is missing we cannot verify -> do not reuse. */
export function answerReusable(trial: Trial, currentContentDigest?: string): boolean {
  if (!currentContentDigest || !trial.questionContentDigest) return false;
  return trial.questionContentDigest === currentContentDigest;
}

export function countCompletedOtherConfig(runsRoot: string, mode: AnswerMode, provider: string, modelId: string, configDigest: string): number {
  let n = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(runsRoot);
  } catch {
    return 0;
  }
  for (const dir of dirs) {
    const td = pathJoin(runsRoot, dir, "trials");
    if (!existsSync(td)) continue;
    let ts: string[] = [];
    try {
      ts = readdirSync(td);
    } catch {
      continue;
    }
    for (const t of ts) {
      const trial = tryReadJson<Trial>(pathJoin(td, t, "trial.json"));
      if (!trial) continue;
      const parsed = TrialSchema.safeParse(trial);
      if (!parsed.success) continue;
      const tr = parsed.data;
      if (tr.mode === mode && tr.provider === provider && tr.modelId === modelId && tr.executionStatus === "completed" && tr.configDigest !== configDigest) n++;
    }
  }
  return n;
}
