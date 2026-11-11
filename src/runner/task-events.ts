/**
 * Structured task events (TS-1). The batch runner emits these so a TUI / Web
 * client consumes EVENTS, not parsed log strings. The service layer and the UI
 * share this vocabulary; business logic stays out of the interface.
 */
import type { AnswerMode, ExecutionStatus, GradingStatus, TerminationCause } from "../shared/contracts.js";
import type { RequestMetrics, TrialMetrics } from "../shared/metrics.js";
import type { BudgetSnapshot } from "./batch-budget.js";

export type TaskEvent =
  | { type: "batch_budget"; runId: string; mode: AnswerMode; budget: BudgetSnapshot }
  | { type: "task_started"; runId: string; mode: AnswerMode; datasetId: string; provider: string; modelId: string; plannedQuestionIds: string[]; at?: string; concurrency?: number; apiConcurrency?: number | null }
  | { type: "question_running"; runId: string; mode: AnswerMode; questionId: string; index: number; total: number; withImages: boolean }
  | { type: "question_done"; runId: string; mode: AnswerMode; questionId: string; executionStatus: ExecutionStatus; terminationCause?: TerminationCause; truncated: boolean; gradingStatus?: GradingStatus; rawScore?: number; maxScore?: number; archiveError?: string; metrics?: TrialMetrics }
  | { type: "question_loaded"; runId: string; mode: AnswerMode; questionId: string; note: string; executionStatus?: ExecutionStatus }
  | { type: "request"; runId: string; mode: AnswerMode; questionId: string; provider: string; modelId: string }
  | { type: "request_metrics"; runId: string; mode: AnswerMode; questionId: string; request: RequestMetrics }
  | { type: "tool_running"; runId: string; mode: AnswerMode; questionId: string; toolName: string }
  | { type: "tool"; runId: string; mode: AnswerMode; questionId: string; toolName: string; isError: boolean; durationMs?: number }
  | { type: "mode_done"; runId: string; mode: AnswerMode; confirmedRaw: number; confirmedMax: number; plannedMax: number; at?: string }
  | { type: "task_done"; runIds: string[] }
  | { type: "stopped"; runId: string; mode: AnswerMode; reason: string; cause?: "batch_token_budget" | "user_stop" }
  | { type: "warning"; runId?: string; mode?: AnswerMode; questionId?: string; message: string }
  | { type: "error"; runId?: string; mode?: AnswerMode; questionId?: string; message: string };
