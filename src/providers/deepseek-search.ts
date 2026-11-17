/**
 * DeepSeek Search/Fetch client (phase 3, /collect only). Contract (official):
 *   POST <base>/v1/tools/search  JSON {query: 1..128 Unicode chars, count: 1..50,
 *        need_content: bool=false}  → 200 {results: [{title,url,snippet,summary,content,...}]}
 *   POST <base>/v1/tools/fetch   JSON {url}  → 200 {title, content}
 *   Errors are OpenAI-compatible: {error: {message,type,param,code}}.
 *   Billing (official list price, 5 元 / 1000 successful requests = 0.005 元 each):
 *   Search bills only a HTTP 200 with non-empty results; empty results are valid and free.
 *   Fetch bills only a HTTP 200 with non-empty content. count does not affect price.
 *
 * Hard rules (AGENTS.md): the API key value is NEVER logged, stored, or echoed; only
 * its env-var NAME is recorded. No automatic retries. URLs must pass publicSearchUrl
 * (public HTTPS only; no credentials/internal hosts). Summaries/snippets/content are
 * untrustedExternalData and never become question evidence without fetch + verification.
 * After HTTP 200 headers arrive the server may have completed and billed even when our
 * read is cancelled/times out or the body is empty/invalid — those are outcomeUnknown.
 * A well-formed {error:{...}} body on HTTP 200 is a definite refusal (outcomeUnknown=false),
 * as are non-200 statuses (402 insufficient balance, 408/429/5xx, other 4xx).
 * Pre-request validation failures (query shape, URL policy) are KNOWN outcomes.
 */
import { z } from "zod";
import { EnvVarNameSchema } from "../shared/contracts.js";
import { assertNoCredentials } from "../shared/creds.js";
import { publicSearchUrl, type ExtractedPage } from "./anysearch.js";

export const DEEPSEEK_SEARCH_BASE = "https://api.deepseek.com";
export const DEEPSEEK_SEARCH_PATH = "/v1/tools/search";
export const DEEPSEEK_FETCH_PATH = "/v1/tools/fetch";
/** 官方刊例价估算：5 元 / 1000 次成功请求；仅为估算，非账单。 */
export const DEEPSEEK_SEARCH_BILLABLE_UNIT_YUAN = 0.005;
export const DEEPSEEK_SEARCH_PRICE_BASIS = "official_list_price_estimate";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEEPSEEK_QUERY_MAX_CHARS = 128;
export const DEEPSEEK_COUNT_MAX = 50;

export type DeepSeekSearchErrorCode =
  | "missing_api_key" | "invalid_query" | "invalid_url"
  | "insufficient_balance" | "rate_limited" | "request_timeout" | "http_error"
  | "api_error" | "invalid_json" | "invalid_schema" | "empty_content"
  | "cancelled" | "timeout" | "connection_failed" | "response_too_large";

export class DeepSeekSearchError extends Error {
  readonly code: DeepSeekSearchErrorCode;
  /** True when the request MAY have reached the server and completed/billed. */
  readonly outcomeUnknown: boolean;
  readonly httpStatus?: number;
  readonly apiErrorCode?: string;
  readonly apiErrorType?: string;
  constructor(code: DeepSeekSearchErrorCode, message: string, outcomeUnknown: boolean, extra: { httpStatus?: number; apiErrorCode?: string; apiErrorType?: string } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.httpStatus = extra.httpStatus;
    this.apiErrorCode = extra.apiErrorCode;
    this.apiErrorType = extra.apiErrorType;
  }
}

const unicodeLength = (text: string) => [...text].length;

export const DeepSeekSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(DEEPSEEK_QUERY_MAX_CHARS, `查询须为 1..${DEEPSEEK_QUERY_MAX_CHARS} 个 Unicode 字符。`)
    .refine((value) => unicodeLength(value) <= DEEPSEEK_QUERY_MAX_CHARS, `查询须为 1..${DEEPSEEK_QUERY_MAX_CHARS} 个 Unicode 字符。`),
  count: z.number().int().min(1).max(DEEPSEEK_COUNT_MAX).default(10),
  need_content: z.boolean().default(false),
}).strict();
export type DeepSeekSearchQuery = z.input<typeof DeepSeekSearchQuerySchema>;

const ErrorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    param: z.string().nullable().optional(),
    code: z.string().optional(),
  }).strict(),
}).strict();

const SearchResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().default(""),
    url: z.string(),
    snippet: z.string().optional(),
    summary: z.string().optional(),
    content: z.string().optional(),
  }).passthrough()),
}).passthrough();

const FetchResponseSchema = z.object({
  title: z.string().default(""),
  content: z.string(),
  truncated: z.boolean().optional(),
}).passthrough();

export interface DeepSeekSearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string | null;
  content: string | null;
  /** Retrieved text is untrusted external data; never question evidence by itself. */
  untrustedExternalData: true;
}

type RawSearchItem = z.infer<typeof SearchResponseSchema>["results"][number];

export interface DeepSeekSearchDetailed {
  /** 通过 publicSearchUrl 核验后的候选链接与摘要（untrustedExternalData）。 */
  results: DeepSeekSearchResult[];
  /** DeepSeek 原始 200 响应 results 长度（URL 过滤前）；官方计费按此口径判定。 */
  providerResultCount: number;
}

export interface DeepSeekSearchOptions {
  /** Env var NAME holding the key. Default DEEPSEEK_API_KEY. Value never recorded. */
  apiKeyEnv?: string;
  getApiKey?: () => string | undefined;
  /** Production must use the official base; a custom base requires an injected fetch (tests). */
  endpoint?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export class DeepSeekSearchClient {
  private readonly apiKeyEnv: string;
  private readonly getApiKey: (() => string | undefined) | undefined;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: DeepSeekSearchOptions = {}) {
    this.apiKeyEnv = options.apiKeyEnv === undefined ? "DEEPSEEK_API_KEY" : EnvVarNameSchema.parse(options.apiKeyEnv);
    this.getApiKey = options.getApiKey;
    this.base = (options.endpoint ?? DEEPSEEK_SEARCH_BASE).replace(/\/+$/, "");
    // 生产默认只允许官方 base；注入自定义 fetch 是测试专用出口。
    if (this.base !== DEEPSEEK_SEARCH_BASE && !options.fetch) {
      throw new Error("DeepSeek Search 端点只允许官方 URL；自定义端点必须同时注入 fetch（仅限测试）。");
    }
    new URL(this.base); // throws on malformed URL
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = z.number().int().positive().max(3_600_000).parse(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = z.number().int().positive().max(512 * 1024 * 1024).parse(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  }

  private key(): string | undefined {
    return this.getApiKey?.() ?? process.env[this.apiKeyEnv];
  }

  private async post(path: string, payload: unknown, signal: AbortSignal | undefined): Promise<{ json: unknown; requestId: string | null }> {
    const key = this.key();
    if (!key) {
      throw new DeepSeekSearchError("missing_api_key",
        `未配置搜索凭据环境变量 ${this.apiKeyEnv}；DeepSeek 搜题不会自动改用匿名身份。`, false);
    }
    assertNoCredentials(payload, "DeepSeek search request");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.timeoutMs);
    const sanitize = (message: string) => (key && message.includes(key) ? "（服务端/传输错误详情已省略，避免写入凭据）" : message);

    const readJson = async (response: Response): Promise<Uint8Array> => {
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
            throw new DeepSeekSearchError("response_too_large",
              `DeepSeek 响应超过大小上限（${this.maxResponseBytes} 字节）；服务端可能已完成处理并计费，结果未知。`, true);
          }
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return Buffer.concat(chunks);
    };

    try {
      let response: Response;
      try {
        response = await this.fetcher(this.base + path, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        if (controller.signal.aborted) {
          if (signal?.aborted && !timedOut) throw new DeepSeekSearchError("cancelled", "DeepSeek 请求已取消；请求可能已到达服务端并计费，结果未知。", true);
          throw new DeepSeekSearchError("timeout", `DeepSeek 请求超时（${this.timeoutMs}ms）；请求可能已到达服务端并计费，结果未知。`, true);
        }
        throw new DeepSeekSearchError("connection_failed",
          `DeepSeek 连接失败：${sanitize((error as Error).message ?? String(error))}；请求已发起，结果未知。`, true);
      }
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");

      // 错误正文读取途中取消/超时：服务端可能已完成，结果仍未知。
      let body: Uint8Array;
      try {
        body = await readJson(response);
      } catch (error) {
        if (controller.signal.aborted) {
          if (signal?.aborted && !timedOut) throw new DeepSeekSearchError("cancelled", "DeepSeek 响应读取已取消；服务端可能已完成并计费，结果未知。", true);
          throw new DeepSeekSearchError("timeout", `DeepSeek 响应读取超时（${this.timeoutMs}ms）；服务端可能已完成并计费，结果未知。`, true);
        }
        throw error;
      }

      let apiCode: string | undefined;
      let apiType: string | undefined;
      if (!response.ok || body.byteLength > 0) {
        try {
          const parsed = ErrorBodySchema.parse(JSON.parse(Buffer.from(body).toString("utf8")));
          apiCode = parsed.error.code ?? undefined;
          apiType = parsed.error.type ?? undefined;
        } catch { /* 非 error 对象的正文按正常/未知响应处理 */ }
      }
      const status = response.status;
      if (!response.ok) {
        if (status === 402 || apiCode === "insufficient_balance") {
          throw new DeepSeekSearchError("insufficient_balance",
            "DeepSeek 账户余额不足（HTTP 402），请求被拒绝；没有自动重试。", false,
            { httpStatus: status, apiErrorCode: apiCode, apiErrorType: apiType });
        }
        if (status === 429) {
          throw new DeepSeekSearchError("rate_limited",
            `DeepSeek 触发限流（HTTP ${status}）；没有自动重试，请稍后再人工决定。`, false,
            { httpStatus: status, apiErrorCode: apiCode, apiErrorType: apiType });
        }
        if (status === 408) {
          throw new DeepSeekSearchError("request_timeout",
            `DeepSeek 服务端超时（HTTP ${status}）；没有自动重试。`, false,
            { httpStatus: status, apiErrorCode: apiCode, apiErrorType: apiType });
        }
        throw new DeepSeekSearchError("http_error",
          `DeepSeek HTTP ${status}；请检查请求与账户状态，没有自动重试。`, false,
          { httpStatus: status, apiErrorCode: apiCode, apiErrorType: apiType });
      }

      const text = Buffer.from(body).toString("utf8").trim();
      if (!text) throw new DeepSeekSearchError("invalid_json", "DeepSeek 返回空响应体；服务端可能已完成并计费，结果未知。", true);
      let json: unknown;
      try { json = JSON.parse(text); }
      catch { throw new DeepSeekSearchError("invalid_json", "DeepSeek 返回的内容不是有效 JSON；服务端可能已完成并计费，结果未知。", true); }
      const errorBody = ErrorBodySchema.safeParse(json);
      if (errorBody.success) {
        // 200 上的 error 对象是确定拒绝：服务端不会为此计费。
        throw new DeepSeekSearchError("api_error",
          `DeepSeek 返回错误：${errorBody.data.error.message ?? errorBody.data.error.code ?? "未知错误"}`, false,
          { httpStatus: status, apiErrorCode: errorBody.data.error.code ?? undefined, apiErrorType: errorBody.data.error.type ?? undefined });
      }
      return { json, requestId };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** 解析并做密钥自检；返回原始 results 条目（URL 过滤前）。 */
  private async searchItems(query: DeepSeekSearchQuery, signal: AbortSignal | undefined): Promise<RawSearchItem[]> {
    const checked = DeepSeekSearchQuerySchema.parse(query);
    const { json, requestId } = await this.post(DEEPSEEK_SEARCH_PATH,
      { query: checked.query, count: checked.count, need_content: checked.need_content }, signal);
    const parsed = SearchResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new DeepSeekSearchError("invalid_schema",
        `DeepSeek 搜索响应不符合契约：${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}；服务端可能已完成并计费，结果未知。`, true);
    }
    const key = this.key();
    if (key && JSON.stringify(json).includes(key)) {
      throw new DeepSeekSearchError("invalid_schema", "DeepSeek 搜索响应包含当前密钥内容，已拒绝保存和展示；服务端可能已完成并计费，结果未知。", true);
    }
    void requestId; // 只随原始响应用于排障，不进入结构化结果
    return parsed.data.results;
  }

  /** 只返回通过 publicSearchUrl 核验的条目；不通过的 URL 被丢弃。 */
  private filterResults(items: RawSearchItem[]): DeepSeekSearchResult[] {
    const results: DeepSeekSearchResult[] = [];
    for (const item of items) {
      let url: string;
      try { url = publicSearchUrl(item.url); }
      catch { continue; }
      results.push({
        title: item.title, url,
        snippet: item.snippet ?? "", summary: item.summary ?? null, content: item.content ?? null,
        untrustedExternalData: true,
      });
    }
    assertNoCredentials(results, "DeepSeek search result");
    return results;
  }

  /**
   * 搜索只返回候选链接与摘要，均标记 untrustedExternalData；空 results 合法且不计费。
   * 每个结果的 URL 都经 publicSearchUrl 核验，不通过的条目被丢弃。
   */
  async search(query: DeepSeekSearchQuery, opts: { signal?: AbortSignal } = {}): Promise<DeepSeekSearchResult[]> {
    return this.filterResults(await this.searchItems(query, opts.signal));
  }

  /**
   * 与 search 相同，但额外返回 providerResultCount：DeepSeek 原始 200 响应 results 长度
   * （URL 过滤前）。计费按官方口径以原始结果数判定，本地过滤为空不影响已发生用量。
   */
  async searchDetailed(query: DeepSeekSearchQuery, opts: { signal?: AbortSignal } = {}): Promise<DeepSeekSearchDetailed> {
    const items = await this.searchItems(query, opts.signal);
    return { results: this.filterResults(items), providerResultCount: items.length };
  }

  /**
   * 抓取公开 HTTPS 页面正文。只有 HTTP 200 且正文非空才算成功（才可能计费）；
   * 响应明确 truncated 时保留该标记；空正文视为不完整失败。
   */
  async fetchPage(raw: string, opts: { signal?: AbortSignal } = {}): Promise<ExtractedPage> {
    let url: string;
    try { url = publicSearchUrl(raw); }
    catch (error) {
      throw new DeepSeekSearchError("invalid_url", (error as Error).message, false);
    }
    const { json } = await this.post(DEEPSEEK_FETCH_PATH, { url }, opts.signal);
    const parsed = FetchResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new DeepSeekSearchError("invalid_schema",
        `DeepSeek 抓取响应不符合契约：${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}；服务端可能已完成并计费，结果未知。`, true);
    }
    if (!parsed.data.content.trim()) {
      // 200 但正文为空：官方规则不计费；正文缺失视为不完整材料。
      throw new DeepSeekSearchError("empty_content", "DeepSeek 抓取返回空正文，视为不完整材料；按官方规则不计费。", false,
        { httpStatus: 200 });
    }
    const page: ExtractedPage = {
      url, title: parsed.data.title, content: parsed.data.content,
      truncated: parsed.data.truncated === true, contentType: null,
    };
    const key = this.key();
    if (key && JSON.stringify(page).includes(key)) {
      throw new DeepSeekSearchError("invalid_schema", "DeepSeek 抓取响应包含当前密钥内容，已拒绝保存和展示；服务端可能已完成并计费，结果未知。", true);
    }
    assertNoCredentials(page, "DeepSeek fetch result");
    return page;
  }
}
