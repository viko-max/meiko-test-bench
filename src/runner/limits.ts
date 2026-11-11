/**
 * Protection-limit guard (AGENTS.md §7/§9). Counts turns, tool calls and elapsed
 * time; over-limit is FLAGGED (never silently truncated into a normal answer).
 */
import type { ProtectionLimits, TerminationCause } from "../shared/contracts.js";

export class LimitGuard {
  private turns = 0;
  private toolCalls = 0;
  private readonly startedAt = Date.now();
  private cause?: TerminationCause;

  constructor(private readonly limits: ProtectionLimits) {}

  stop(cause: TerminationCause): void { this.cause ??= cause; }
  get terminationCause(): TerminationCause | undefined { return this.cause; }

  countTurn(): void {
    this.turns += 1;
  }

  countToolCall(): boolean {
    this.toolCalls += 1;
    return this.toolCalls <= this.limits.maxToolCalls;
  }

  get turnCount(): number {
    return this.turns;
  }

  get toolCallCount(): number {
    return this.toolCalls;
  }

  get totalRunTimeMs(): number {
    return this.limits.totalRunTimeMs;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Which limit (if any) is currently exceeded. */
  exceeded(): "maxTurns" | "maxToolCalls" | "totalRunTimeMs" | null {
    if (this.turns >= this.limits.maxTurns) return "maxTurns";
    if (this.toolCalls > this.limits.maxToolCalls) return "maxToolCalls";
    if (this.elapsedMs() >= this.limits.totalRunTimeMs) return "totalRunTimeMs";
    return null;
  }
}
