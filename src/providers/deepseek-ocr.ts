/**
 * DeepSeek OCR client (phase 1, /import only). Contract (verified):
 *   POST <endpoint>  multipart fields: file, purpose (rich_layout_recognition)
 *   Input: PDF / PNG / JPEG / WebP / GIF / BMP / TIFF, ≤100MiB, ≤1000 pages.
 *   The server streams leading newlines while recognising; the final body is ONE
 *   JSON document. HTTP 200 may still carry {error: {...}}. finish_reason
 *   "length" means the page text was truncated. page_count must equal
 *   pages.length with complete 0-based indexes. Billing follows the successful
 *   page_count; usage is informational.
 *
 * Hard rules (AGENTS.md §4/§10): the API key value is NEVER logged, stored, or
 * echoed; only its env-var NAME is recorded. No automatic retries: after the
 * upload starts the server may keep processing and billing even when our
 * connection drops, so cancellation / timeout / mid-flight connection failure
 * surface as outcomeUnknown=true and the caller must consult the provider
 * records instead of resubmitting. The same applies once HTTP 200 headers
 * arrive: an empty body, invalid JSON, a schema violation or a page mismatch
 * means the full recognised result is untrustworthy while the server may have
 * finished and billed — all outcomeUnknown=true. A well-formed {error: {...}}
 * body on HTTP 200 is a definite provider refusal (outcomeUnknown=false).
 * Pre-upload validation failures are KNOWN outcomes (outcomeUnknown=false).
 */
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import { EnvVarNameSchema } from "../shared/contracts.js";

export const DEEPSEEK_OCR_PURPOSE = "rich_layout_recognition";
export const DEEPSEEK_OCR_ENDPOINT = "https://api.deepseek.com/v1/tools/ocr";
export const DEEPSEEK_OCR_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000; // 官方默认总时限 180 秒
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export const OCR_SOURCE_EXT = /\.(?:pdf|png|jpe?g|webp|gif|bmp|tiff?)$/i;
const EXT_MEDIA: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
};

export function isOcrSourcePath(path: string): boolean {
  return OCR_SOURCE_EXT.test(path);
}

export type DeepSeekOcrErrorCode =
  | "unsupported_file" | "empty_file" | "file_too_large" | "missing_api_key"
  | "insufficient_balance" | "rate_limited" | "request_timeout" | "http_error"
  | "api_error" | "invalid_json" | "invalid_schema" | "page_mismatch"
  | "cancelled" | "timeout" | "connection_failed" | "response_too_large";

export class DeepSeekOcrError extends Error {
  readonly code: DeepSeekOcrErrorCode;
  /** True when the request MAY have reached the server and continued/billed. */
  readonly outcomeUnknown: boolean;
  readonly httpStatus?: number;
  readonly apiErrorCode?: string;
  readonly apiErrorType?: string;
  constructor(code: DeepSeekOcrErrorCode, message: string, outcomeUnknown: boolean, extra: { httpStatus?: number; apiErrorCode?: string; apiErrorType?: string } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.httpStatus = extra.httpStatus;
    this.apiErrorCode = extra.apiErrorCode;
    this.apiErrorType = extra.apiErrorType;
  }
}

const OcrResponseSchema = z.object({
  id: z.string().min(1),
  object: z.literal("ocr.result"),
  created: z.number(),
  purpose: z.string().min(1),
  page_count: z.number().int().nonnegative(),
  pages: z.array(z.object({
    index: z.number().int().nonnegative(),
    text: z.string(),
    finish_reason: z.enum(["stop", "length"]),
  })),
  usage: z.object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    total_tokens: z.number().nonnegative(),
  }),
});

const OcrErrorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    param: z.string().nullable().optional(),
    code: z.string().optional(),
  }).strict(),
}).strict();

export interface DeepSeekOcrPage {
  index: number;
  text: string;
  finishReason: "stop" | "length";
}

export interface DeepSeekOcrResult {
  id: string;
  created: number;
  purpose: string;
  pageCount: number;
  pages: DeepSeekOcrPage[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Provider request id from response headers (never auth material). */
  requestId: string | null;
  /** Schema-validated response body; safe to archive (no auth headers). */
  raw: unknown;
}

export interface DeepSeekOcrOptions {
  /** Env var NAME holding the key. Default DEEPSEEK_API_KEY. Value never recorded. */
  apiKeyEnv?: string;
  getApiKey?: () => string | undefined;
  /** Production must use the official URL; a custom endpoint requires an injected fetch (tests). */
  endpoint?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export class DeepSeekOcrClient {
  private readonly apiKeyEnv: string;
  private readonly getApiKey: (() => string | undefined) | undefined;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: DeepSeekOcrOptions = {}) {
    this.apiKeyEnv = options.apiKeyEnv === undefined ? "DEEPSEEK_API_KEY" : EnvVarNameSchema.parse(options.apiKeyEnv);
    this.getApiKey = options.getApiKey;
    this.endpoint = options.endpoint ?? DEEPSEEK_OCR_ENDPOINT;
    // 生产默认只允许官方 URL；注入自定义 fetch 是测试专用出口。
    if (this.endpoint !== DEEPSEEK_OCR_ENDPOINT && !options.fetch) {
      throw new Error("DeepSeek OCR 端点只允许官方 URL；自定义端点必须同时注入 fetch（仅限测试）。");
    }
    new URL(this.endpoint); // throws on malformed URL
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = z.number().int().positive().max(3_600_000).parse(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = z.number().int().positive().max(512 * 1024 * 1024).parse(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  }

  private key(): string | undefined {
    return this.getApiKey?.() ?? process.env[this.apiKeyEnv];
  }

  /** 上传前校验：这些失败发生在请求之前，结果是确定的（outcomeUnknown=false）。 */
  private readValidatedSource(sourcePath: string): { bytes: Uint8Array; filename: string; mediaType: string } {
    const ext = extname(sourcePath).toLowerCase();
    const mediaType = EXT_MEDIA[ext];
    if (!mediaType) {
      throw new DeepSeekOcrError("unsupported_file",
        `DeepSeek OCR 首版仅支持 PDF/PNG/JPEG/WebP/GIF/BMP/TIFF：${basename(sourcePath)}`, false);
    }
    let size: number;
    try { size = statSync(sourcePath).size; } catch (error) {
      throw new DeepSeekOcrError("unsupported_file", `OCR 来源文件不可读：${(error as Error).message}`, false);
    }
    if (size === 0) throw new DeepSeekOcrError("empty_file", `OCR 来源文件为空：${basename(sourcePath)}`, false);
    if (size > DEEPSEEK_OCR_MAX_FILE_BYTES) {
      throw new DeepSeekOcrError("file_too_large", `OCR 来源文件超过 100MiB 上限（${basename(sourcePath)}）`, false);
    }
    let bytes: Uint8Array;
    try { bytes = readFileSync(sourcePath); } catch (error) {
      throw new DeepSeekOcrError("unsupported_file", `OCR 来源文件读取失败：${(error as Error).message}`, false);
    }
    if (bytes.byteLength === 0) throw new DeepSeekOcrError("empty_file", `OCR 来源文件为空：${basename(sourcePath)}`, false);
    if (bytes.byteLength > DEEPSEEK_OCR_MAX_FILE_BYTES) {
      throw new DeepSeekOcrError("file_too_large", `OCR 来源文件超过 100MiB 上限（${basename(sourcePath)}）`, false);
    }
    return { bytes, filename: basename(sourcePath), mediaType };
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
          throw new DeepSeekOcrError("response_too_large",
            `DeepSeek OCR 响应超过大小上限（${this.maxResponseBytes} 字节）；识别可能已在服务端完成并计费，结果未知。`, true);
        }
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }

  /** 识别一个 PDF/图片文件。绝不自动重试；取消/超时/已发起后断连 → outcomeUnknown。 */
  async recognize(sourcePath: string, opts: { signal?: AbortSignal } = {}): Promise<DeepSeekOcrResult> {
    const { bytes, filename, mediaType } = this.readValidatedSource(sourcePath);
    const key = this.key();
    if (!key) {
      throw new DeepSeekOcrError("missing_api_key",
        `未配置 OCR 凭据环境变量 ${this.apiKeyEnv}；不会自动改用匿名身份。`, false);
    }
    const external = opts.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    external?.addEventListener("abort", abort, { once: true });
    if (external?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.timeoutMs);
    const sanitize = (message: string) => (key && message.includes(key) ? "（服务端/传输错误详情已省略，避免写入凭据）" : message);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), filename);
    form.append("purpose", DEEPSEEK_OCR_PURPOSE);

    try {
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          if (external?.aborted && !timedOut) throw new DeepSeekOcrError("cancelled", "DeepSeek OCR 请求已取消；上传可能已到达服务端并继续处理/计费，结果未知。", true);
          throw new DeepSeekOcrError("timeout", `DeepSeek OCR 请求超时（${this.timeoutMs}ms）；上传可能已到达服务端并继续处理/计费，结果未知。`, true);
        }
        // 请求已发起但连接失败：服务端可能已收到并计费，不能当作确定失败。
        throw new DeepSeekOcrError("connection_failed",
          `DeepSeek OCR 连接失败：${sanitize((error as Error).message ?? String(error))}；请求已发起，结果未知。`, true);
      }

      const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");

      if (!response.ok) {
        // 读取错误正文时若被取消/超时，结果仍未知（服务端已完成处理），不得当作确定 HTTP 错误。
        let body: Uint8Array;
        try {
          body = await this.readBody(response);
        } catch (error) {
          if (controller.signal.aborted) {
            if (external?.aborted && !timedOut) throw new DeepSeekOcrError("cancelled", "DeepSeek OCR 错误响应读取已取消；服务端可能已完成处理并计费，结果未知。", true);
            throw new DeepSeekOcrError("timeout", `DeepSeek OCR 错误响应读取超时（${this.timeoutMs}ms）；服务端可能已完成处理并计费，结果未知。`, true);
          }
          if (error instanceof DeepSeekOcrError) throw error;
          body = new Uint8Array();
        }
        let apiCode: string | undefined;
        let apiType: string | undefined;
        try {
          const parsed = OcrErrorBodySchema.parse(JSON.parse(Buffer.from(body).toString("utf8")));
          apiCode = parsed.error.code ?? undefined;
          apiType = parsed.error.type ?? undefined;
        } catch { /* 非 JSON 错误正文不进入错误信息 */ }
        const status = response.status;
        if (status === 402 || apiCode === "insufficient_balance") {
          throw new DeepSeekOcrError("insufficient_balance",
            "DeepSeek 账户余额不足（HTTP 402），识别被拒绝；没有自动重试。", false,
            { httpStatus: status, apiErrorCode: apiCode, apiErrorType: apiType });
        }
        if (status === 429) {
          throw new DeepSeekOcrError("rate_limited",
            `DeepSeek OCR 触发限流（HTTP ${status}）；没有自动重试，请稍后再人工决定。`, false,
            { httpStatus: status, apiErrorCode: apiCode, apiErrorType: apiType });
        }
        if (status === 408) {
          throw new DeepSeekOcrError("request_timeout",
            `DeepSeek OCR 服务端超时（HTTP ${status}）；没有自动重试。`, false,
            { httpStatus: status, apiErrorCode: apiCode, apiErrorType: apiType });
        }
        throw new DeepSeekOcrError("http_error",
          `DeepSeek OCR HTTP ${status}；请检查请求与账户状态，没有自动重试。`, false,
          { httpStatus: status, apiErrorCode: apiCode, apiErrorType: apiType });
      }

      // 200 后读取正文被取消/超时：服务端可能已完成识别并计费，保持结果未知。
      let body: Uint8Array;
      try {
        body = await this.readBody(response);
      } catch (error) {
        if (controller.signal.aborted) {
          if (external?.aborted && !timedOut) throw new DeepSeekOcrError("cancelled", "DeepSeek OCR 响应读取已取消；识别可能已在服务端完成并计费，结果未知。", true);
          throw new DeepSeekOcrError("timeout", `DeepSeek OCR 响应读取超时（${this.timeoutMs}ms）；识别可能已在服务端完成并计费，结果未知。`, true);
        }
        throw error;
      }
      // 前导换行/空白是识别中的心跳，不代表完成；只在完整 JSON 到齐后解析。
      const text = Buffer.from(body).toString("utf8").trim();
      if (!text) throw new DeepSeekOcrError("invalid_json", "DeepSeek OCR 返回空响应体；识别可能已在服务端完成并计费，结果未知。", true);
      let json: unknown;
      try { json = JSON.parse(text); }
      catch { throw new DeepSeekOcrError("invalid_json", "DeepSeek OCR 返回的内容不是有效 JSON；识别可能已在服务端完成并计费，结果未知。", true); }

      const errorBody = OcrErrorBodySchema.safeParse(json);
      if (errorBody.success) {
        // 明确的 error 对象是确定结果：服务端拒绝了识别，不会完成或计费。
        throw new DeepSeekOcrError("api_error",
          `DeepSeek OCR 返回错误：${errorBody.data.error.message ?? errorBody.data.error.code ?? "未知错误"}`, false,
          { apiErrorCode: errorBody.data.error.code ?? undefined, apiErrorType: errorBody.data.error.type ?? undefined });
      }

      const parsed = OcrResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new DeepSeekOcrError("invalid_schema",
          `DeepSeek OCR 响应不符合契约：${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}；识别可能已在服务端完成并计费，结果未知。`, true);
      }
      const data = parsed.data;
      if (data.page_count !== data.pages.length) {
        throw new DeepSeekOcrError("page_mismatch",
          `DeepSeek OCR 页数不一致：page_count=${data.page_count}，实际返回 ${data.pages.length} 页；识别可能已在服务端完成并计费，结果未知。`, true);
      }
      const indexes = data.pages.map((page) => page.index).sort((a, b) => a - b);
      if (indexes.some((index, i) => index !== i)) {
        throw new DeepSeekOcrError("page_mismatch",
          `DeepSeek OCR 页索引不完整或不连续：${indexes.join(",")}；识别可能已在服务端完成并计费，结果未知。`, true);
      }
      if (json && typeof json === "object" && key && JSON.stringify(json).includes(key)) {
        throw new DeepSeekOcrError("invalid_schema", "DeepSeek OCR 响应包含当前密钥内容，已拒绝保存和展示；识别可能已在服务端完成并计费，结果未知。", true);
      }
      return {
        id: data.id, created: data.created, purpose: data.purpose, pageCount: data.page_count,
        pages: data.pages.map((page) => ({ index: page.index, text: page.text, finishReason: page.finish_reason })),
        usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, totalTokens: data.usage.total_tokens },
        requestId, raw: json,
      };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    }
  }
}
