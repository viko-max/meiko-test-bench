/**
 * 通用 SystemOne 决策客户端（第二阶段 /review）。契约：
 *   POST <profile.baseUrl>  JSON { model, state, questions: { [q.id]: questionDef } }  Bearer 凭据
 *   - 官方 questionDef：choice/multi-choice = { type, instructions, criteria:{选项:描述} }；
 *     noul = { type, instructions }；extract = { type, instructions, criteria, context: state }；
 *     span = { type, instructions }（不得带 criteria/context）。请求绝不携带内部
 *     id/question/options 数组字段。
 *   - 蚂蚁 envelope="ant"：model=lingdt-decision-1.0；errorCode!==0 一律确定
 *     business_error（errorDesc/errorMsg 描述，即使缺 model/usage/answers）；
 *     errorCode===0 才要求 answers/model/usage 完整；支持 choice/noul/multi-choice/extract。
 *   - 象信/百炼 envelope="standard"：无蚂蚁 errorCode，HTTP 200 + 合法 schema 即成功；
 *     象信支持 choice/noul/span（span 的 state 为答卷字符串，start/end 为 Unicode
 *     码点左闭右开；响应头 x-request-id / x-xiangxin-model-ms / x-xiangxin-total-ms）。
 *
 * Hard rules（AGENTS.md §4/§10/§12）：key 值绝不记录/存档；绝不自动重试；
 * 取消/超时/已发起后断连 → outcomeUnknown=true（服务端可能已完成并计费）；
 * 明确的 HTTP 错误（402/429/408/5xx、业务 errorCode）→ outcomeUnknown=false。
 * 每个请求问题都必须收到对应 type 的合法答案，否则按 invalid_schema 拒绝
 * （HTTP 200 后拒绝 → 结果未知）。响应体/错误正文若包含当前凭据 → 拒绝
 * （credential_leak，确定结果），错误消息绝不回显 key。
 */
import { z } from "zod";
import { DecisionProviderProfileSchema, type DecisionProviderProfile, type DecisionUsage } from "../shared/decision.js";

export const DEFAULT_DECISION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type SystemOneErrorCode =
  | "missing_api_key" | "invalid_profile" | "insufficient_balance" | "rate_limited" | "request_timeout"
  | "http_error" | "business_error" | "invalid_json" | "invalid_schema" | "cancelled" | "timeout"
  | "connection_failed" | "response_too_large" | "credential_leak";

export class SystemOneError extends Error {
  readonly code: SystemOneErrorCode;
  /** True when the request MAY have reached the server and continued/billed. */
  readonly outcomeUnknown: boolean;
  readonly httpStatus?: number;
  readonly apiErrorCode?: string | number;
  constructor(code: SystemOneErrorCode, message: string, outcomeUnknown: boolean, extra: { httpStatus?: number; apiErrorCode?: string | number } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.httpStatus = extra.httpStatus;
    this.apiErrorCode = extra.apiErrorCode;
  }
}

// ---------- 请求问题与答案契约 ----------
export const DecisionChoiceConclusions = ["explicit_single", "explicit_multiple", "no_conclusion", "insufficient_evidence"] as const;

export type DecisionQuestion =
  | { id: string; type: "choice"; question: string; options: string[]; optionDescriptions?: Record<string, string> }
  | { id: string; type: "noul"; question: string }
  | { id: string; type: "multi-choice"; question: string; options: string[]; optionDescriptions?: Record<string, string> }
  | { id: string; type: "extract"; question: string }
  | { id: string; type: "span"; question: string };

export interface ExtractSpan {
  type: string;
  text: string;
  start: number;
  end: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface SpanSpan {
  path: string;
  start: number;
  end: number;
  text: string;
  confidence?: number | null;
}

export type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; value: number; confidence: number | null }
  | { type: "multi-choice"; choices: string[]; probabilities: Record<string, number>; confidence: number }
  | { type: "extract"; spans: ExtractSpan[]; modelSpanCount: number; truncated: boolean }
  | { type: "span"; spans: SpanSpan[] };

const ProbabilityMap = z.record(z.string(), z.number().min(0).max(1));

const ChoiceAnswerSchema = z.object({
  type: z.string().optional(),
  choice: z.string().min(1),
  probabilities: ProbabilityMap,
  confidence: z.number().min(0).max(1),
});
/** 官方 noul 答案字段是 `noul`（0..1），内部统一转换为 value。 */
const NoulAnswerSchema = z.object({
  type: z.string().optional(),
  noul: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).optional(),
});
const MultiChoiceAnswerSchema = z.object({
  type: z.string().optional(),
  choices: z.array(z.string().min(1)),
  probabilities: ProbabilityMap,
  confidence: z.number().min(0).max(1),
});
const ExtractAnswerSchema = z.object({
  spans: z.array(z.object({
    type: z.string().min(1),
    text: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    probabilities: ProbabilityMap.optional(),
    confidence: z.number().min(0).max(1).optional(),
  })),
  model_span_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
const SpanAnswerSchema = z.object({
  spans: z.array(z.object({
    path: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    text: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
  })),
});

/** usage：input 必有；output/total 可缺（百炼可只有 input）。缺失归一化为 0 /
 *  input+output 计；unknown 字段不导致整单无效（passthrough）。raw 永远保留原值。 */
const UsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative().optional(),
  total_tokens: z.number().nonnegative().optional(),
}).passthrough();

const AnswersRecordSchema = z.record(z.string(), z.unknown());

/** 蚂蚁最小信封：只要 errorCode 可解析，业务错误就是确定结果（errorDesc/errorMsg 均可）。 */
const AntEnvelopeSchema = z.object({
  errorCode: z.number(),
  errorDesc: z.string().optional(),
  errorMsg: z.string().optional(),
}).passthrough();

/** 蚂蚁成功信封：errorCode===0 才要求 model/usage/answers 完整。 */
const AntSuccessBodySchema = z.object({
  errorCode: z.number(),
  model: z.string().min(1),
  usage: UsageSchema,
  answers: AnswersRecordSchema,
  warnings: z.array(z.string()).optional(),
});
/** standard 信封：象信/百炼，无 errorCode。 */
const StandardBodySchema = z.object({
  model: z.string().min(1),
  usage: UsageSchema,
  answers: AnswersRecordSchema,
  warnings: z.array(z.string()).optional(),
});

export interface SystemOneDecisionResult {
  /** provider 实际返回的 model。 */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
  warnings: string[];
  requestId: string | null;
  latencyMs: number;
  providerModelMs: number | null;
  providerTotalMs: number | null;
  /** Schema 校验通过的安全响应体（绝不包含认证头）。 */
  raw: unknown;
}

export interface SystemOneClientOptions {
  /** 只读取环境变量名；值绝不记录。 */
  getApiKey?: () => string | undefined;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** 生产只允许声明的 https 端点；注入 fetch 时允许本机测试端点。 */
  fetch?: typeof globalThis.fetch;
}

export class SystemOneClient {
  private readonly getApiKey: (() => string | undefined) | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly profile: DecisionProviderProfile, options: SystemOneClientOptions = {}) {
    this.profile = DecisionProviderProfileSchema.parse(profile);
    this.getApiKey = options.getApiKey;
    new URL(this.profile.baseUrl); // throws on malformed URL
    // 生产默认只允许声明的 https 端点；注入 fetch 是测试专用出口（本机 HTTP）。
    if (!this.profile.baseUrl.startsWith("https://") && !options.fetch) {
      throw new Error(`决策端点只允许声明的 https 地址：${this.profile.id}；自定义/本机端点必须同时注入 fetch（仅限测试）。`);
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = z.number().int().positive().max(3_600_000).parse(options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS);
    this.maxResponseBytes = z.number().int().positive().max(128 * 1024 * 1024).parse(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  }

  private key(): string | undefined {
    return this.getApiKey?.() ?? process.env[this.profile.apiKeyEnv];
  }

  /** 含当前凭据的文本不得进入任何错误消息或存档内容；命中则整段剔除。 */
  private scrubKey(text: string): string {
    const key = this.key();
    return key && text.includes(key) ? "" : text;
  }

  /** 安全响应体（rawSafeResponse 来源）绝不允许包含当前凭据。 */
  private assertRawSafe(json: unknown): void {
    const key = this.key();
    if (!key) return;
    let text = "";
    try { text = JSON.stringify(json) ?? ""; } catch { return; }
    if (text.includes(key)) {
      throw new SystemOneError("credential_leak",
        "决策响应体包含本次请求凭据内容，按安全契约拒绝返回与存档；请核对服务侧日志并尽快轮换该凭据。（消息不回显凭据本身）", false);
    }
  }

  /** 官方 questionDef：绝不携带内部 id/question/options 数组字段。 */
  private buildOfficialQuestion(q: DecisionQuestion, state: string): Record<string, unknown> {
    if (q.type === "choice" || q.type === "multi-choice") {
      return {
        type: q.type,
        instructions: q.question,
        criteria: Object.fromEntries(q.options.map((o) => [o, q.optionDescriptions?.[o] ?? o])),
      };
    }
    if (q.type === "noul") return { type: "noul", instructions: q.question };
    if (q.type === "extract") {
      return {
        type: "extract",
        instructions: q.question,
        criteria: { answer_evidence: "支持最终结论的原文片段" },
        context: state,
      };
    }
    return { type: "span", instructions: q.question }; // span 不得带 criteria/context
  }

  private async readBody(response: Response): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > this.maxResponseBytes) {
          throw new SystemOneError("response_too_large",
            `决策响应超过大小上限（${this.maxResponseBytes} 字节）；服务端可能已完成并计费，结果未知。`, true);
        }
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }

  /** 校验每个请求问题都收到对应 type 的合法答案；不合法 → invalid_schema。 */
  private validateAnswers(questions: DecisionQuestion[], answers: Record<string, unknown>): Record<string, DecisionAnswer> {
    const out: Record<string, DecisionAnswer> = {};
    const fail = (id: string, why: string): never => {
      throw new SystemOneError("invalid_schema", `决策响应不符合契约：问题 ${id} 的答案不合法（${why}）。服务端可能已完成并计费，结果未知。`, true);
    };
    const must = <S>(id: string, why: string, result: z.SafeParseReturnType<unknown, S>): S => {
      if (result.success) return result.data;
      return fail(id, why);
    };
    for (const q of questions) {
      const raw = answers[q.id];
      if (raw === undefined) fail(q.id, `缺少 type=${q.type} 的答案`);
      if (q.type === "choice") {
        const data = must(q.id, "choice 需要 choice/probabilities/confidence", ChoiceAnswerSchema.safeParse(raw));
        if (data.type !== undefined && data.type !== "choice") fail(q.id, `答案 type=${data.type} 与请求 type=choice 不一致`);
        if (!q.options.includes(data.choice)) fail(q.id, `choice=${data.choice} 不在候选选项内`);
        for (const opt of q.options) if (data.probabilities[opt] === undefined) fail(q.id, `probabilities 缺少选项 ${opt}`);
        out[q.id] = { type: "choice", choice: data.choice, probabilities: data.probabilities, confidence: data.confidence };
      } else if (q.type === "noul") {
        const data = must(q.id, "noul 需要 0..1 的 noul 字段", NoulAnswerSchema.safeParse(raw));
        out[q.id] = { type: "noul", value: data.noul, confidence: data.confidence ?? null };
      } else if (q.type === "multi-choice") {
        const data = must(q.id, "multi-choice 需要 choices/probabilities/confidence", MultiChoiceAnswerSchema.safeParse(raw));
        if (data.type !== undefined && data.type !== "multi-choice") fail(q.id, `答案 type=${data.type} 与请求 type=multi-choice 不一致`);
        if (!data.choices.length) fail(q.id, "choices 为空");
        for (const c of data.choices) if (!q.options.includes(c)) fail(q.id, `选项 ${c} 不在题面候选内`);
        for (const opt of q.options) if (data.probabilities[opt] === undefined) fail(q.id, `probabilities 缺少选项 ${opt}`);
        out[q.id] = { type: "multi-choice", choices: data.choices, probabilities: data.probabilities, confidence: data.confidence };
      } else if (q.type === "extract") {
        const data = must(q.id, "extract 需要 spans/model_span_count/truncated", ExtractAnswerSchema.safeParse(raw));
        out[q.id] = {
          type: "extract", modelSpanCount: data.model_span_count, truncated: data.truncated,
          spans: data.spans.map((s) => ({ type: s.type, text: s.text, start: s.start, end: s.end, probabilities: s.probabilities, confidence: s.confidence })),
        };
      } else {
        const data = must(q.id, "span 需要 spans[{path,start,end,text,confidence}]", SpanAnswerSchema.safeParse(raw));
        out[q.id] = { type: "span", spans: data.spans.map((s) => ({ path: s.path, start: s.start, end: s.end, text: s.text, confidence: s.confidence ?? null })) };
      }
    }
    return out;
  }

  /** 发起一次决策请求。绝不自动重试。 */
  async decide(state: string, questions: DecisionQuestion[], opts: { signal?: AbortSignal } = {}): Promise<SystemOneDecisionResult> {
    if (!questions.length) throw new SystemOneError("invalid_profile", "至少需要一个决策问题。", false);
    for (const q of questions) {
      if ((q.type === "choice" || q.type === "multi-choice") && !q.options.length) {
        throw new SystemOneError("invalid_profile", `问题 ${q.id} 缺少候选选项。`, false);
      }
    }
    const key = this.key();
    if (!key) {
      throw new SystemOneError("missing_api_key",
        `未配置决策凭据环境变量 ${this.profile.apiKeyEnv}；不会自动改用匿名身份。`, false);
    }
    const external = opts.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    external?.addEventListener("abort", abort, { once: true });
    if (external?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.timeoutMs);
    const startedAt = Date.now();
    const unknownRead = (phase: string): SystemOneError => {
      if (external?.aborted && !timedOut) return new SystemOneError("cancelled", `决策${phase}已取消；服务端可能已完成并计费，结果未知。`, true);
      return new SystemOneError("timeout", `决策${phase}超时（${this.timeoutMs}ms）；服务端可能已完成并计费，结果未知。`, true);
    };

    try {
      const body = JSON.stringify({
        model: this.profile.model,
        state,
        questions: Object.fromEntries(questions.map((q) => [q.id, this.buildOfficialQuestion(q, state)])),
      });
      let response: Response;
      try {
        response = await this.fetcher(this.profile.baseUrl, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body,
        });
      } catch (error) {
        if (controller.signal.aborted) throw unknownRead("请求");
        // 请求已发起但连接失败：服务端可能已收到并计费，不能当作确定失败。
        throw new SystemOneError("connection_failed",
          `决策连接失败：${(error as Error).message ?? String(error)}；请求已发起，结果未知。`, true);
      }

      const requestId = response.headers.get("x-request-id");
      const modelMsHeader = response.headers.get("x-xiangxin-model-ms");
      const totalMsHeader = response.headers.get("x-xiangxin-total-ms");
      const providerModelMs = modelMsHeader !== null && modelMsHeader !== "" ? Number(modelMsHeader) : null;
      const providerTotalMs = totalMsHeader !== null && totalMsHeader !== "" ? Number(totalMsHeader) : null;

      if (!response.ok) {
        let bytes: Uint8Array;
        try {
          bytes = await this.readBody(response);
        } catch (error) {
          if (controller.signal.aborted) throw unknownRead("错误响应读取");
          if (error instanceof SystemOneError) throw error;
          bytes = new Uint8Array();
        }
        const status = response.status;
        let detail = "";
        try {
          const parsedError = JSON.parse(Buffer.from(bytes).toString("utf8"));
          detail = typeof parsedError?.detail === "string" ? this.scrubKey(parsedError.detail) : "";
        } catch { /* 非 JSON 错误正文不进入错误信息 */ }
        const suffix = detail ? `：${detail}` : "";
        if (status === 402) {
          throw new SystemOneError("insufficient_balance", `决策账户余额不足（HTTP 402${suffix}），请求被拒绝；没有自动重试。`, false, { httpStatus: status });
        }
        if (status === 429) {
          throw new SystemOneError("rate_limited", `决策接口触发限流（HTTP 429${suffix}）；没有自动重试，请稍后再人工决定。`, false, { httpStatus: status });
        }
        if (status === 408) {
          throw new SystemOneError("request_timeout", `决策服务端超时（HTTP 408${suffix}）；没有自动重试。`, false, { httpStatus: status });
        }
        throw new SystemOneError("http_error", `决策接口 HTTP ${status}${suffix}；没有自动重试。`, false, { httpStatus: status });
      }

      let bytes: Uint8Array;
      try {
        bytes = await this.readBody(response);
      } catch (error) {
        if (controller.signal.aborted) throw unknownRead("响应读取");
        throw error;
      }
      const text = Buffer.from(bytes).toString("utf8").trim();
      if (!text) throw new SystemOneError("invalid_json", "决策接口返回空响应体；服务端可能已完成并计费，结果未知。", true);
      let json: unknown;
      try { json = JSON.parse(text); }
      catch { throw new SystemOneError("invalid_json", "决策接口返回的内容不是有效 JSON；服务端可能已完成并计费，结果未知。", true); }

      // 信封校验：蚂蚁先解析 errorCode——非 0 一律确定 business_error（即使缺
      // model/usage/answers）；errorCode===0 才要求完整成功契约。standard 无 errorCode。
      let model: string;
      let usage: { input_tokens: number; output_tokens?: number; total_tokens?: number };
      let answersRaw: Record<string, unknown>;
      let warnings: string[];
      if (this.profile.envelope === "ant") {
        const envelope = AntEnvelopeSchema.safeParse(json);
        if (!envelope.success) {
          throw new SystemOneError("invalid_schema",
            `蚂蚁决策响应不符合契约：缺少可解析的 errorCode；服务端可能已完成并计费，结果未知。`, true);
        }
        if (envelope.data.errorCode !== 0) {
          const detail = this.scrubKey(envelope.data.errorDesc ?? envelope.data.errorMsg ?? "");
          throw new SystemOneError("business_error",
            `蚂蚁决策业务错误 errorCode=${envelope.data.errorCode}${detail ? `：${detail}` : ""}；这是确定结果。`, false,
            { apiErrorCode: envelope.data.errorCode });
        }
        const parsed = AntSuccessBodySchema.safeParse(json);
        if (!parsed.success) {
          throw new SystemOneError("invalid_schema",
            `蚂蚁决策响应不符合契约：${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}；服务端可能已完成并计费，结果未知。`, true);
        }
        model = parsed.data.model;
        usage = parsed.data.usage;
        answersRaw = parsed.data.answers;
        warnings = parsed.data.warnings ?? [];
      } else {
        const parsed = StandardBodySchema.safeParse(json);
        if (!parsed.success) {
          throw new SystemOneError("invalid_schema",
            `决策响应不符合契约：${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}；服务端可能已完成并计费，结果未知。`, true);
        }
        model = parsed.data.model;
        usage = parsed.data.usage;
        answersRaw = parsed.data.answers;
        warnings = parsed.data.warnings ?? [];
      }
      const answers = this.validateAnswers(questions, answersRaw);
      this.assertRawSafe(json);
      // usage 归一化：output/total 缺失记 0 / input+output（raw 保留原值）。
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens ?? 0;
      const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
      return {
        model, answers,
        usage: { inputTokens, outputTokens, totalTokens },
        warnings, requestId,
        latencyMs: Date.now() - startedAt,
        providerModelMs: providerModelMs !== null && Number.isFinite(providerModelMs) ? providerModelMs : null,
        providerTotalMs: providerTotalMs !== null && Number.isFinite(providerTotalMs) ? providerTotalMs : null,
        raw: json,
      };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    }
  }
}
