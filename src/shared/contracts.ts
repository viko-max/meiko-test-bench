/**
 * Internal contracts (AGENTS.md §3/§5). Public questions and scoring specs are
 * DISTINCT types. Requests are built only from PublicQuestion via a field
 * whitelist; scoring material must never enter a request, tool input, or .work.
 */
import { z } from "zod";
import { AnswerIsolationError } from "./errors.js";
import { TrialMetricsSchema } from "./metrics.js";

// ---------- shared primitives ----------
export const IdentifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/, "lowercase ASCII [a-z0-9_.-]");
export const VersionSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "version token");
/** Environment variable NAME only — never a value. */
export const EnvVarNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/, "ENV_VAR_NAME");

// ---------- enums ----------
export const AnswerMode = z.enum(["without_tool", "with_tool"]);
export type AnswerMode = z.infer<typeof AnswerMode>;

export const ExecutionStatus = z.enum([
  "pending",
  "queued",
  "running",
  "completed",
  "failed_unprocessed",
  "outcome_unknown",
  "interrupted",
  "limit_reached",
  "unsupported_input",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const GradingStatus = z.enum([
  "ungraded",
  "rule_graded",
  "model_preliminary",
  "pending_human_review",
  "human_confirmed",
]);
export type GradingStatus = z.infer<typeof GradingStatus>;

export const AnswerKind = z.enum([
  "single_choice",
  "multi_choice",
  "multi_blank",
  "numeric_unit",
  "expression",
  "open",
  "out_of_scope",
]);
export type AnswerKind = z.infer<typeof AnswerKind>;

export const CapabilityState = z.enum(["verified", "unverified", "unsupported"]);
export type CapabilityState = z.infer<typeof CapabilityState>;

// ---------- PublicQuestion (whitelist only; no scoring fields) ----------
export const PublicAssetSchema = z
  .object({
    ref: z.string().min(1),
    mediaType: z.string().min(1),
    role: z.string().min(1),
    alt: z.string().optional(),
  })
  .strict();
export type PublicAsset = z.infer<typeof PublicAssetSchema>;

export const PublicPartSchema = z
  .object({
    label: z.string().min(1),
    prompt: z.string(),
  })
  .strict();
export type PublicPart = z.infer<typeof PublicPartSchema>;

export const PublicQuestionSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema,
    subject: z.string().min(1), // extensible label, not a fixed enum
    answerKind: AnswerKind,
    language: z.string().default("zh"),
    tags: z.array(z.string()).default([]),
    stem: z.string().min(1), // markdown; LaTeX preserved verbatim
    options: z.record(z.string(), z.string()).optional(),
    parts: z.array(PublicPartSchema).optional(),
    assets: z.array(PublicAssetSchema).default([]),
  })
  .strict();
export type PublicQuestion = z.infer<typeof PublicQuestionSchema>;

/** Fields allowed to reach a model request. Everything else is dropped. */
export const PUBLIC_QUESTION_REQUEST_FIELDS = [
  "id",
  "version",
  "subject",
  "answerKind",
  "language",
  "tags",
  "stem",
  "options",
  "parts",
  "assets",
] as const;

const SCORING_ONLY_ASSET_ROLES = new Set(["answer_key", "answer_key_page", "scoring_sheet", "solution"]);

/** Build the request-facing payload from a validated PublicQuestion. */
export function publicRequestPayload(q: PublicQuestion): Record<string, unknown> {
  const src = q as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_QUESTION_REQUEST_FIELDS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  // Defense in depth: strip any scoring-role asset that slipped in.
  if (Array.isArray(out.assets)) {
    out.assets = (out.assets as PublicAsset[]).filter((a) => !SCORING_ONLY_ASSET_ROLES.has(a.role));
  }
  return out;
}

/** Reject questions whose public assets carry answer content. */
export function assertPublicAssetsClean(q: PublicQuestion): void {
  for (const a of q.assets) {
    if (SCORING_ONLY_ASSET_ROLES.has(a.role)) {
      throw new AnswerIsolationError(`question ${q.id} asset ${a.ref} has scoring role '${a.role}'`);
    }
  }
}

// ---------- ScoringSpec (separate; never in a request) ----------
export const RubricItemSchema = z
  .object({
    partLabel: z.string().optional(),
    points: z.number().finite().nonnegative(),
    evidence: z.string().optional(),
    acceptAlternatives: z.array(z.string()).default([]),
  })
  .strict();
export type RubricItem = z.infer<typeof RubricItemSchema>;

export const ScoringSpecSchema = z
  .object({
    questionId: IdentifierSchema,
    questionVersion: VersionSchema,
    scoringVersion: VersionSchema,
    answerKind: AnswerKind,
    maxScore: z.number().finite().nonnegative(),
    reference: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
    rubric: z.array(RubricItemSchema).default([]),
    tolerance: z.number().finite().nonnegative().optional(),
    units: z.array(z.string()).default([]),
    acceptableAlternatives: z.array(z.string()).default([]),
    reviewConditions: z.string().optional(),
    deterministicLocked: z.boolean().default(false),
  })
  .strict();
export type ScoringSpec = z.infer<typeof ScoringSpecSchema>;

// ---------- ModelProfile ----------
export const ModelEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.array(z.enum(["text", "image"])).default(["text"]),
    reasoning: z.boolean().default(false),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  })
  .strict();
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const CapabilitySchema = z
  .object({
    text: CapabilityState.default("unverified"),
    imageInput: CapabilityState.default("unverified"),
    toolCalling: CapabilityState.default("unverified"),
    imageToolResult: CapabilityState.default("unverified"),
    usage: CapabilityState.default("unverified"),
    nativeWebSearch: CapabilityState.default("unverified"),
    verificationEvidence: z.string().nullable().default(null),
  })
  .strict();
export type Capability = z.infer<typeof CapabilitySchema>;

export const PricingSchema = z
  .object({
    source: z.string().min(1),
    date: z.string().min(1),
    inputPerMTok: z.number().nullable().default(null),
    outputPerMTok: z.number().nullable().default(null),
    cacheReadPerMTok: z.number().nullable().default(null),
    cacheWritePerMTok: z.number().nullable().default(null),
  })
  .strict();
export type Pricing = z.infer<typeof PricingSchema>;

export const ModelProfileSchema = z
  .object({
    id: IdentifierSchema,
    displayName: z.string().min(1),
    provider: z.string().min(1),
    api: z.string().min(1),
    baseUrl: z.string().url(),
    auth: z.object({ envVars: z.array(EnvVarNameSchema).min(1) }).strict(),
    models: z.array(ModelEntrySchema).min(1),
    capability: CapabilitySchema.default({}),
    pricing: PricingSchema.optional(),
  })
  .strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelsConfigSchema = z
  .object({
    version: z.string(),
    profiles: z.array(ModelProfileSchema).min(1),
  })
  .strict();
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

// ---------- RunSpec ----------
export const ProtectionLimitsSchema = z
  .object({
    requestTimeoutMs: z.number().int().positive().default(120000),
    maxOutputTokens: z.number().int().positive().default(8192),
    totalRunTimeMs: z.number().int().positive().default(600000),
    maxTurns: z.number().int().positive().default(40),
    maxToolCalls: z.number().int().positive().default(60),
    perToolTimeoutMs: z.number().int().positive().default(60000),
    maxOutputBytes: z.number().int().positive().default(262144),
    maxImagePixels: z.number().int().positive().default(16777216),
  })
  .strict();
export type ProtectionLimits = z.infer<typeof ProtectionLimitsSchema>;

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
export const TerminationCauseSchema = z.enum(["completed", "user_stop", "total_time_limit", "context_limit", "turn_limit", "tool_call_limit", "provider_error", "provider_abort", "execution_error", "input_rejected", "output_token_limit", "empty_response", "batch_token_budget"]);
export type TerminationCause = z.infer<typeof TerminationCauseSchema>;

export const RunSpecSchema = z
  .object({
    datasetId: IdentifierSchema,
    datasetVersion: VersionSchema,
    questionId: IdentifierSchema,
    questionVersion: VersionSchema,
    provider: z.string().min(1),
    modelId: z.string().min(1),
    mode: AnswerMode,
    promptVersion: VersionSchema,
    toolsVersion: VersionSchema,
    limits: ProtectionLimitsSchema,
      thinkingLevel: ThinkingLevelSchema.optional(),
    questionContentDigest: z.string().optional(), // P1-C: stem+attachment content digest
  })
  .strict();
export type RunSpec = z.infer<typeof RunSpecSchema>;

// ---------- Trial (execution record) ----------
export const TrialSchema = z
  .object({
    trialId: z.string().min(1),
    datasetId: IdentifierSchema,
    datasetVersion: VersionSchema,
    questionId: IdentifierSchema,
    questionVersion: VersionSchema,
    provider: z.string().min(1),
    modelId: z.string().min(1),
    mode: AnswerMode,
    configDigest: z.string().min(1),
    promptVersion: VersionSchema,
    toolsVersion: VersionSchema,
    executionStatus: ExecutionStatus,
    truncated: z.boolean().default(false),
    finalAnswerSheet: z.string().nullable().default(null),
    stopReason: z.string().nullable().default(null),
    terminationCause: TerminationCauseSchema.optional(),
    executionPolicyVersion: z.string().optional(),
    errorMessage: z.string().nullable().default(null),
    gradingStatus: GradingStatus.default("ungraded"),
    metrics: TrialMetricsSchema.optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    questionContentDigest: z.string().optional(), // P1-1b: stem+attachment content digest (resume reuse check)
  })
  .strict();
export type Trial = z.infer<typeof TrialSchema>;

// ---------- Grade ----------
export const GradeItemSchema = z
  .object({
    partLabel: z.string().optional(),
    points: z.number(),
    evidence: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();
export type GradeItem = z.infer<typeof GradeItemSchema>;

export const GradeSchema = z
  .object({
    gradeId: z.string().min(1),
    trialId: z.string().min(1),
    questionId: IdentifierSchema,
    scoringVersion: VersionSchema,
    scoringDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    graderKind: z.enum(["rule", "model", "human"]),
    rawScore: z.number(),
    maxScore: z.number().nonnegative(),
    items: z.array(GradeItemSchema).default([]),
    reviewStatus: GradingStatus,
    reviewReason: z.string().min(1).optional(),
    createdAt: z.string(),
  })
  .strict();
export type Grade = z.infer<typeof GradeSchema>;

// ---------- scoring-leak scan (last gate before send) ----------
const SCORING_KEY_VOCAB = [
  "reference",
  "answer",
  "answers",
  "reference_answer",
  "reference_solution",
  "solution",
  "rubric",
  "marking_scheme",
  "max_score",
  "maxscore",
  "tolerance",
  "gold",
  "grader",
  "scoring",
  "answer_key",
];

/** Return paths of any scoring-vocabulary keys found in an arbitrary object. */
export function findScoringLeaks(value: unknown, path = "$"): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findScoringLeaks(v, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SCORING_KEY_VOCAB.includes(k.toLowerCase())) hits.push(`${path}.${k}`);
      hits.push(...findScoringLeaks(v, `${path}.${k}`));
    }
  }
  return hits;
}

/** Throw if a public payload carries scoring material. */
export function assertNoScoringLeak(payload: unknown): void {
  const leaks = findScoringLeaks(payload);
  if (leaks.length > 0) {
    throw new AnswerIsolationError(`scoring material in request payload at ${leaks.join(", ")}`);
  }
}
