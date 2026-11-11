import type { TaskEvent } from "../runner/task-events.js";
import { summarizeRequests, type RequestMetrics, type MetricsSummary } from "../shared/metrics.js";
import type { BudgetSnapshot } from "../runner/batch-budget.js";

export interface LiveQuestion {
  questionId: string;
  state: string;
  terminationCause?: string;
  requests: RequestMetrics[];
  toolName?: string;
  toolCalls: number;
  toolErrors: number;
  reused: boolean;
  summary: MetricsSummary;
}
export interface TaskTelemetry {
  budget?: BudgetSnapshot;
  runId: string; mode: string; provider: string; modelId: string;
  concurrency: number | null; apiConcurrency: number | "unlimited" | null;
  elapsedMs: number | null; questions: LiveQuestion[];
  summary: MetricsSummary;
  processed: number; reused: number; toolCalls: number; toolErrors: number; activeRequests: number;
}

/** 每个请求仅保留最新累计快照；复用答卷不计入本次运行的消耗。 */
export function taskTelemetry(events: TaskEvent[], now = Date.now()): TaskTelemetry | undefined {
  const started = [...events].reverse().find((event) => event.type === "task_started");
  if (!started || started.type !== "task_started") return undefined;
  const questions = new Map<string, LiveQuestion>(started.plannedQuestionIds.map((questionId) => [questionId,
    { questionId, state: "queued", requests: [], toolCalls: 0, toolErrors: 0, reused: false, summary: summarizeRequests([]) }]));
  let ended: string | undefined;
  for (const event of events) {
    if (!("runId" in event) || event.runId !== started.runId) continue;
    if (event.type === "mode_done") ended = event.at;
    if (!("questionId" in event) || !event.questionId) continue;
    const question = questions.get(event.questionId);
    if (!question) continue;
    switch (event.type) {
      case "question_running": question.state = "running"; break;
      case "question_done": question.state = event.executionStatus; question.terminationCause = event.terminationCause; question.toolName = undefined; break;
      case "question_loaded": question.state = event.executionStatus ?? "loaded"; question.reused = true; break;
      case "request_metrics": {
        const index = question.requests.findIndex((request) => request.id === event.request.id);
        if (index < 0) question.requests.push(event.request);
        else question.requests[index] = event.request;
        if (event.request.endedAt === null) { question.state = event.request.phase; question.toolName = undefined; }
        break;
      }
      case "tool_running": question.state = "tool"; question.toolName = event.toolName; break;
      case "tool": question.toolCalls++; if (event.isError) question.toolErrors++; question.toolName = undefined; question.state = "running"; break;
    }
  }
  const elapsed = started.at ? Math.max(0, (ended ? Date.parse(ended) : now) - Date.parse(started.at)) : null;
  const elapsedMs = elapsed !== null && Number.isFinite(elapsed) ? elapsed : null;
  const items = [...questions.values()];
  for (const question of items) question.summary = summarizeRequests(question.requests);
  const terminalStates = new Set(["completed", "failed_unprocessed", "outcome_unknown", "interrupted", "limit_reached", "unsupported_input", "loaded"]);
  const budget = [...events].reverse().find((event) => event.type === "batch_budget" && event.runId === started.runId);
  return {
    ...(budget?.type === "batch_budget" ? { budget: budget.budget } : {}),
    runId: started.runId, mode: started.mode, provider: started.provider, modelId: started.modelId,
    concurrency: started.concurrency ?? null, apiConcurrency: started.apiConcurrency === undefined ? null : started.apiConcurrency ?? "unlimited",
    elapsedMs, questions: items, summary: summarizeRequests(items.flatMap((question) => question.requests), elapsedMs ?? undefined),
    processed: items.filter((question) => terminalStates.has(question.state)).length,
    reused: items.filter((question) => question.reused).length,
    toolCalls: items.reduce((sum, question) => sum + question.toolCalls, 0),
    toolErrors: items.reduce((sum, question) => sum + question.toolErrors, 0),
    activeRequests: items.flatMap((question) => question.requests).filter((request) => request.endedAt === null).length,
  };
}
