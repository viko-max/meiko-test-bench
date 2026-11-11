import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";
import { writeJsonAtomic } from "../shared/json.js";
import { LimitExceededError } from "../shared/errors.js";
import { contextBudget } from "./context-budget.js";
import { RequestMetricsCollector } from "./request-metrics.js";

export const BatchTokenLimitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const TokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const EntrySchema = z.object({
  id: z.string().min(1), runId: z.string().min(1), trialId: z.string().min(1), questionId: z.string().min(1),
  reserved: BatchTokenLimitSchema, actual: TokenCountSchema.nullable(),
  state: z.enum(["active", "known", "unknown"]),
  reconciliation: z.object({ by: z.string().trim().min(1), reason: z.string().trim().min(1), at: z.string() }).optional(),
}).strict();
const LedgerSchema = z.object({ version: z.literal(1), maxTotalTokens: BatchTokenLimitSchema, entries: z.array(EntrySchema) }).strict().superRefine((ledger, ctx) => {
  const ids = new Set<string>();
  for (const entry of ledger.entries) {
    if (ids.has(entry.id) || (entry.state === "known") !== (entry.actual !== null)) ctx.addIssue({ code: "custom", message: "预算记录包含重复请求或状态与用量不一致。" });
    ids.add(entry.id);
  }
});
export type BudgetEntry = z.infer<typeof EntrySchema>;
export interface BudgetSnapshot {
  reconciledTokens: number;
  maxTotalTokens: number; knownTokens: number; reservedTokens: number; unknownReservedTokens: number;
  activeRequests: number; unknownRequests: number; remainingTokens: number; blocked: boolean;
}

export function budgetSnapshot(ledger: z.infer<typeof LedgerSchema>): BudgetSnapshot {
  const knownTokens = ledger.entries.reduce((sum, e) => sum + (e.actual ?? 0), 0);
  const reservedTokens = ledger.entries.filter((e) => e.state === "active").reduce((sum, e) => sum + e.reserved, 0);
  const unknown = ledger.entries.filter((e) => e.state === "unknown");
  const unknownReservedTokens = unknown.reduce((sum, e) => sum + e.reserved, 0);
  const remainingTokens = Math.max(0, ledger.maxTotalTokens - knownTokens - reservedTokens - unknownReservedTokens);
  return { maxTotalTokens: ledger.maxTotalTokens, knownTokens, reservedTokens, unknownReservedTokens,
    reconciledTokens: ledger.entries.filter((e) => e.reconciliation).reduce((sum, e) => sum + (e.actual ?? 0), 0),
    activeRequests: ledger.entries.filter((e) => e.state === "active").length, unknownRequests: unknown.length,
    remainingTokens, blocked: unknown.length > 0 || remainingTokens === 0 };
}

export class BatchTokenBudget {
  private fault = false;
  private ledger: z.infer<typeof LedgerSchema>;
  constructor(private readonly path: string, maxTotalTokens: number, resume: boolean,
    private publish?: (snapshot: BudgetSnapshot) => void) {
    BatchTokenLimitSchema.parse(maxTotalTokens);
    if (resume && !existsSync(path)) throw new Error("批次预算记录缺失，拒绝重新计算为零。");
    if (!resume && existsSync(path)) throw new Error("批次预算记录已存在，拒绝覆盖。");
    this.ledger = resume ? LedgerSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : { version: 1, maxTotalTokens, entries: [] };
    if (this.ledger.maxTotalTokens !== maxTotalTokens) throw new Error("续跑预算必须与原批次一致。");
    // 上个进程留下的预留可能已经计费，恢复时绝不能释放。
    for (const entry of this.ledger.entries) if (entry.state === "active") entry.state = "unknown";
    this.save();
  }
  snapshot(): BudgetSnapshot { const snapshot = budgetSnapshot(this.ledger); return { ...snapshot, blocked: snapshot.blocked || this.fault }; }
  setPublisher(publish: (snapshot: BudgetSnapshot) => void): void { this.publish = publish; }
  private save(): void {
    try { writeJsonAtomic(this.path, this.ledger); }
    catch (error) { this.fault = true; throw error; }
    this.publish?.(this.snapshot());
  }

  wrap(inner: StreamFn, identity: Pick<BudgetEntry, "runId" | "trialId" | "questionId">, onDenied: () => void,
    reservationBasis: "contextWindow" | "inputTokens" = "contextWindow"): StreamFn {
    return (model, context, options) => {
      const check = contextBudget(model, context.messages as Message[], options?.maxTokens ?? model.maxTokens);
      // 聊天按本次输入估算预留，额外保留一份输入估算作为误差空间；测评沿用原预留策略。
      const margin = reservationBasis === "inputTokens" ? Math.max(128, check.estimatedInputTokens) : check.margin;
      const reserve = Math.ceil(check.estimatedInputTokens + margin + check.outputReserve);
      const before = this.snapshot();
      if (before.blocked || reserve > before.remainingTokens) {
        onDenied();
        throw new LimitExceededError("batchTotalTokens", `批次剩余额度 ${before.remainingTokens}，请求需预留 ${reserve}；未知用量 ${before.unknownRequests} 条。请求未发送。`);
      }
      const entry: BudgetEntry = { ...identity, id: randomUUID(), reserved: reserve, actual: null, state: "active" };
      this.ledger.entries.push(entry);
      // 先持久化再调用下游；落盘失败必须停止发送。
      this.save();
      const metrics = new RequestMetricsCollector((metric) => {
        if (!metric.endedAt || entry.state !== "active") return;
        const total = metric.usage.totalTokens ?? (metric.usage.input !== null && metric.usage.output !== null ? metric.usage.input + metric.usage.output : null);
        if (metric.status === "completed" && total !== null && TokenCountSchema.safeParse(total).success) { entry.actual = total; entry.state = "known"; }
        else entry.state = "unknown";
        this.save();
      });
      return metrics.wrap(inner)(model, context, options);
    };
  }
}

export function readBudget(path: string) {
  const ledger = LedgerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return { ...budgetSnapshot(ledger), entries: ledger.entries };
}

export function reconcileBudget(path: string, id: string, total: number, by: string, reason: string): void {
  const ledger = LedgerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  TokenCountSchema.parse(total);
  const reconciliation = EntrySchema.shape.reconciliation.unwrap().parse({ by, reason, at: new Date().toISOString() });
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry || entry.state !== "unknown") throw new Error("只能核对已结束且用量未知的请求。");
  entry.actual = total; entry.state = "known"; entry.reconciliation = reconciliation;
  writeJsonAtomic(path, ledger);
}
