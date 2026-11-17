/**
 * 第二阶段 /review 决策模型契约（AGENTS.md §12）。严格 zod contracts：
 * 决策辅助只针对已归档的真实 Trial 答卷，结果是“辅助、必须人工确认”的记录，
 * 绝不修改 Grade/报告/原答卷；记录里只保存环境变量名与安全响应，绝不保存 key。
 */
import { z } from "zod";
import { AnswerMode, EnvVarNameSchema, IdentifierSchema } from "./contracts.js";

export const DECISION_ASSISTANCE_SCHEMA = "decision-assistance/1";

/** 决策问题类型：choice/noul 所有 profile 共有；multi-choice/extract 为蚂蚁；span 为象信。 */
export const DecisionCapabilitySchema = z.enum(["choice", "noul", "multi-choice", "extract", "span"]);
export type DecisionCapability = z.infer<typeof DecisionCapabilitySchema>;

/** ant = 蚂蚁信封（必须有 errorCode===0）；standard = 象信/百炼等无 errorCode 信封。 */
export const DecisionEnvelopeSchema = z.enum(["ant", "standard"]);
export type DecisionEnvelope = z.infer<typeof DecisionEnvelopeSchema>;

export const DecisionProviderProfileSchema = z
  .object({
    id: IdentifierSchema,
    displayName: z.string().min(1),
    baseUrl: z.string().url(),
    /** 只保存凭据的环境变量名；绝不保存值。 */
    apiKeyEnv: EnvVarNameSchema,
    model: z.string().min(1),
    envelope: DecisionEnvelopeSchema,
    capabilities: z.array(DecisionCapabilitySchema).min(1),
    enabled: z.boolean().default(true),
    /** 候选说明（如未实现路由的候选 provider），不进入请求。 */
    notes: z.string().optional(),
  })
  .strict();
export type DecisionProviderProfile = z.infer<typeof DecisionProviderProfileSchema>;

export const DECISION_ANT_BASE_URL = "https://maas-api.antdigital.com/v1/systemone";
export const DECISION_XIANGXIN_BASE_URL = "https://api.xiangxinai.cn/v1/systemone";

/** 默认蚂蚁 profile（lingdt-decision-1.0，ant 信封，choice/noul/multi-choice/extract）。 */
export const ANT_DECISION_PROFILE: DecisionProviderProfile = DecisionProviderProfileSchema.parse({
  id: "ant-decision",
  displayName: "蚂蚁决策 (lingdt-decision)",
  baseUrl: DECISION_ANT_BASE_URL,
  apiKeyEnv: "ANT_DECISION_API_KEY",
  model: "lingdt-decision-1.0",
  envelope: "ant",
  capabilities: ["choice", "noul", "multi-choice", "extract"],
  enabled: true,
});

/** 默认象信 profile（xiangxin-3.8，standard 信封，choice/noul/span）。 */
export const XIANGXIN_DECISION_PROFILE: DecisionProviderProfile = DecisionProviderProfileSchema.parse({
  id: "xiangxin-decision",
  displayName: "象信决策 (xiangxin-3.8)",
  baseUrl: DECISION_XIANGXIN_BASE_URL,
  apiKeyEnv: "XIANGXIN_API_KEY",
  model: "xiangxin-3.8",
  envelope: "standard",
  capabilities: ["choice", "noul", "span"],
  enabled: true,
});

/** 百炼可扩展模板：完整 URL（含 workspace）由用户配置，仅 choice/noul，无蚂蚁 errorCode。 */
export const BAILIAN_DECISION_TEMPLATE: DecisionProviderProfile = DecisionProviderProfileSchema.parse({
  id: "bailian-decision",
  displayName: "百炼决策 (decision-model-preview)",
  baseUrl: "https://dashscope.aliyuncs.com/api/v1/systemone",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  model: "decision-model-preview",
  envelope: "standard",
  capabilities: ["choice", "noul"],
  enabled: false,
  notes: "可扩展模板：baseUrl 需改为含 workspace 的完整地址后启用；能力以 choice/noul 为限。",
});

/** 候选说明：volcano/startlux/sii 只登记为 disabled 候选，不实现路由。 */
export const DECISION_CANDIDATE_PROFILES: DecisionProviderProfile[] = [
  DecisionProviderProfileSchema.parse({
    id: "volcano-decision", displayName: "火山决策 (候选)", baseUrl: "https://example.invalid/v1/systemone",
    apiKeyEnv: "VOLCANO_DECISION_API_KEY", model: "volcano-decision-preview", envelope: "standard",
    capabilities: ["choice", "noul"], enabled: false,
    notes: "候选 provider，路由未实现，仅作能力对照说明。",
  }),
  DecisionProviderProfileSchema.parse({
    id: "startlux-decision", displayName: "星耀决策 (候选)", baseUrl: "https://example.invalid/v1/systemone",
    apiKeyEnv: "STARTLUX_DECISION_API_KEY", model: "startlux-decision-preview", envelope: "standard",
    capabilities: ["choice", "noul"], enabled: false,
    notes: "候选 provider，路由未实现，仅作能力对照说明。",
  }),
  DecisionProviderProfileSchema.parse({
    id: "sii-decision", displayName: "智脑决策 (候选)", baseUrl: "https://example.invalid/v1/systemone",
    apiKeyEnv: "SII_DECISION_API_KEY", model: "sii-decision-preview", envelope: "standard",
    capabilities: ["choice", "noul"], enabled: false,
    notes: "候选 provider，路由未实现，仅作能力对照说明。",
  }),
];

/** 默认启用的决策 profile：蚂蚁 + 象信。 */
export const DEFAULT_DECISION_PROFILES: DecisionProviderProfile[] = [ANT_DECISION_PROFILE, XIANGXIN_DECISION_PROFILE];

/** provider 返回 offset 的可能编码；UI 一律使用 UTF16 码元位置。 */
export const DecisionEvidenceEncodingSchema = z.enum(["utf16", "codepoint", "utf8"]);
export type DecisionEvidenceEncoding = z.infer<typeof DecisionEvidenceEncodingSchema>;

/** 证据必须能精确定位回答卷原文；quote 为原文精确切片。 */
export const DecisionEvidenceSchema = z
  .object({
    quote: z.string().min(1),
    /** UI 位置：UTF16 码元，左闭右开。 */
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    /** provider 原始位置（其编码由 encoding 说明，左闭右开）。 */
    providerStart: z.number().int().nonnegative(),
    providerEnd: z.number().int().nonnegative(),
    encoding: DecisionEvidenceEncodingSchema,
    /** provider 的 path；象信 span 固定为 ""（整份答卷字符串）。 */
    providerPath: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine((e) => e.end > e.start, { message: "evidence end must be > start" });
export type DecisionEvidence = z.infer<typeof DecisionEvidenceSchema>;

export const DecisionUsageSchema = z
  .object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  })
  .strict();
export type DecisionUsage = z.infer<typeof DecisionUsageSchema>;

export const DecisionErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    /** true = 请求可能已到达服务端并继续处理/计费。 */
    outcomeUnknown: z.boolean(),
    httpStatus: z.number().int().optional(),
  })
  .strict();
export type DecisionAssistanceError = z.infer<typeof DecisionErrorSchema>;

/** 决策辅助记录：追加到 trial 目录 decision-reviews.jsonl，最新一份原子写 decision-review.json。 */
export const DecisionAssistanceRecordSchema = z
  .object({
    recordId: z.string().min(1),
    schemaVersion: z.literal(DECISION_ASSISTANCE_SCHEMA),
    trialId: z.string().min(1),
    /** trial 实际所在运行目录（可能是续跑前的历史运行）。 */
    sourceRunId: z.string().min(1),
    mode: AnswerMode,
    providerId: IdentifierSchema,
    /** 本次请求使用的模型 id（profile.model）。 */
    requestedModel: z.string().min(1),
    /** provider 实际返回的 model；失败/未知时为 null。 */
    actualModel: z.string().nullable(),
    status: z.enum(["completed", "failed", "outcome_unknown"]),
    /** 决策辅助永远只是辅助：必须人工确认后才能采信。 */
    needsHumanReview: z.literal(true),
    /** 共同 choice：explicit_single/explicit_multiple/no_conclusion/insufficient_evidence。 */
    choice: z.enum(["explicit_single", "explicit_multiple", "no_conclusion", "insufficient_evidence"]).nullable(),
    /** 是否有明确最终结论（0..1）。 */
    noul: z.number().min(0).max(1).nullable(),
    /** 各候选（共同四选项或题面 A..Z）的概率。 */
    probabilities: z.record(z.string(), z.number().min(0).max(1)).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    /** 选中的题面选项（多选如 ["A","J"]）。 */
    selectedOptions: z.array(z.string()).default([]),
    /** 已逐段校验确实来自原答卷的证据。 */
    evidence: z.array(DecisionEvidenceSchema).default([]),
    usage: DecisionUsageSchema.nullable(),
    requestId: z.string().nullable(),
    latencyMs: z.number().nonnegative().nullable(),
    providerModelMs: z.number().nonnegative().nullable(),
    providerTotalMs: z.number().nonnegative().nullable(),
    warnings: z.array(z.string()).default([]),
    error: DecisionErrorSchema.nullable(),
    /** 校验通过的安全响应体（不含认证头）；失败/未知时为 null。 */
    rawSafeResponse: z.unknown().nullable(),
    /** 因 profile 能力缺失而没有发送的问题等，显式列出、绝不静默降级。 */
    limitations: z.array(z.string()).default([]),
    /** 定位失败的证据段（quote 保留、位置不可信），仍需人工核对。 */
    unlocalizedEvidence: z
      .array(
        z
          .object({
            quote: z.string().min(1),
            providerPath: z.string(),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    createdAt: z.string().min(1),
  })
  .strict();
export type DecisionAssistanceRecord = z.infer<typeof DecisionAssistanceRecordSchema>;
