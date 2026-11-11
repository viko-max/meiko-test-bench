import { z } from "zod";
import { EnvVarNameSchema, IdentifierSchema, PublicQuestionSchema, ScoringSpecSchema, ThinkingLevelSchema, VersionSchema } from "./contracts.js";
import { TrialMetricsSchema } from "./metrics.js";

export const COLLECTION_WORKFLOW_VERSION = "collection-v2";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const CollectionConfigSchema = z.object({
  datasetId: IdentifierSchema, version: VersionSchema.default("1"),
  profileId: IdentifierSchema, modelId: z.string().min(1), thinkingLevel: ThinkingLevelSchema.default("off"),
  apiKeyEnv: EnvVarNameSchema.optional(),
  targetCount: positive.optional(),
  limits: z.object({
    maxTotalTokens: positive, maxOutputTokens: positive.default(4096), maxModelRequests: positive.default(30),
    maxSearchRequests: positive.default(20), maxExtractRequests: positive.default(20), maxCapabilityRequests: positive.default(5),
    maxToolCalls: positive.default(80), maxCandidates: positive.default(100),
    requestTimeoutMs: positive.default(30000), turnTimeoutMs: positive.default(180000),
    maxSourceBytes: positive.default(2097152),
  }).strict(),
}).strict().refine((config) => config.targetCount === undefined || config.targetCount <= config.limits.maxCandidates,
  { message: "目标题数不能超过候选题数量上限。", path: ["targetCount"] });
export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;
export const CollectionSourceSchema = z.object({
  id: z.string(), url: z.string(), title: z.string(), content: z.string(), digest: z.string(),
  fetchedAt: z.string(), truncated: z.boolean(), contentType: z.string().nullable(),
}).strict();
export type CollectionSource = z.infer<typeof CollectionSourceSchema>;
const EvidenceSchema = z.object({ sourceId: z.string().min(1), quote: z.string().min(1), location: z.string().min(1) }).strict();
export const CollectionCandidateSchema = z.object({
  question: PublicQuestionSchema, scoring: ScoringSpecSchema.optional(),
  originalId: z.string().optional(), sourceId: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1), answerEvidence: z.array(EvidenceSchema).default([]),
}).strict();
export type CollectionCandidateInput = z.input<typeof CollectionCandidateSchema>;
export const CollectionSessionSchema = z.object({
  schema: z.literal("meiko-collection/1"), id: z.string().regex(/^collection-[a-f0-9-]{36}$/),
  config: CollectionConfigSchema, modelIdentity: z.string(), skillVersion: z.string(), skillCommit: z.string(),
  workflowVersion: z.string().optional(),
  goal: z.string().min(1), createdAt: z.string(),
  state: z.enum(["ready", "running", "stopped", "paused", "outcome_unknown", "error"]), error: z.string().optional(),
  counts: z.object({ model: z.number().int().nonnegative(), search: z.number().int().nonnegative(), extract: z.number().int().nonnegative(),
    capabilities: z.number().int().nonnegative(), tools: z.number().int().nonnegative() }).strict(),
  sources: z.array(CollectionSourceSchema),
  candidates: z.array(CollectionCandidateSchema.extend({ fingerprint: z.string(), issues: z.array(z.string()) }).strict()),
  operations: z.array(z.object({ key: z.string(), kind: z.enum(["search", "extract", "capabilities"]),
    state: z.enum(["started", "completed", "unknown"]), result: z.unknown().optional() }).strict()),
  transcript: z.array(z.unknown()),
  metrics: TrialMetricsSchema.optional(),
}).strict();
export type CollectionSession = z.infer<typeof CollectionSessionSchema>;
