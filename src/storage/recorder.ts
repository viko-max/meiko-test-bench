/**
 * Trial recorder contract. The runner records facts (events, requests, tool
 * records, the final answer sheet) without guessing or backfilling data
 * (AGENTS.md §3). Concrete impls: InMemoryTrialRecorder (tests) and RunStore.
 */
export interface TrialRecorder {
  recordEvent(event: unknown): void;
  recordRequest(snapshot: unknown): void;
  recordTool(record: unknown): void;
  setAnswerSheet(text: string): void;
}

export class InMemoryTrialRecorder implements TrialRecorder {
  readonly events: unknown[] = [];
  readonly requests: unknown[] = [];
  readonly tools: unknown[] = [];
  answerSheet: string | null = null;

  recordEvent(event: unknown): void {
    this.events.push(event);
  }
  recordRequest(snapshot: unknown): void {
    this.requests.push(snapshot);
  }
  recordTool(record: unknown): void {
    this.tools.push(record);
  }
  setAnswerSheet(text: string): void {
    this.answerSheet = text;
  }
}
