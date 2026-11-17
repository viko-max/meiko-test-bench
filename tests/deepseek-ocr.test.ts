import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DeepSeekOcrClient, DeepSeekOcrError } from "../src/providers/deepseek-ocr.js";

let root: string;
beforeAll(() => {
  mkdirSync(resolve(".work"), { recursive: true });
  root = mkdtempSync(resolve(".work", "deepseek-ocr-"));
});
afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY; // 绝不读取真实凭据；测试只使用注入的假 key
});

interface Captured {
  method?: string;
  authorization?: string;
  body: Buffer;
}

async function withServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void, fn: (endpoint: string, captured: Captured) => Promise<void>): Promise<void> {
  const captured: Captured = { body: Buffer.alloc(0) };
  const server: Server = createServer((req, res) => {
    captured.method = req.method;
    captured.authorization = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { captured.body = Buffer.concat(chunks); void handler(req, res); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}/v1/tools/ocr`, captured);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
  }
}

const SUCCESS = {
  id: "ocr-result-1", object: "ocr.result", created: 1730000000,
  purpose: "rich_layout_recognition", page_count: 1,
  pages: [{ index: 0, text: "1. 求 $x^2$ 的顶点坐标。<｜ref｜>配图甲<｜/ref｜><｜box｜>[[10,20,300,200]]<｜/box｜>", finish_reason: "stop" }],
  usage: { input_tokens: 120, output_tokens: 60, total_tokens: 180 },
};

const clientFor = (endpoint: string, extra: ConstructorParameters<typeof DeepSeekOcrClient>[0] = {}) =>
  new DeepSeekOcrClient({ endpoint, fetch: globalThis.fetch, getApiKey: () => "test-key-value", ...extra });

function pngFile(name = "sample.png"): string {
  const path = join(root, name);
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-bytes")]));
  return path;
}

describe("DeepSeekOcrClient（真实 client 对本机 HTTP 测试服务）", () => {
  it("multipart 只含 file/purpose，Authorization 只断言存在、不记录值；前导换行后解析完整 JSON", async () => {
    await withServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("x-request-id", "req-123");
      res.end("\n\n" + JSON.stringify(SUCCESS)); // 识别中前导换行
    }, async (endpoint, captured) => {
      const file = pngFile();
      const result = await clientFor(endpoint).recognize(file);
      expect(captured.method).toBe("POST");
      expect(captured.authorization).toMatch(/^Bearer \S+$/);
      // 只记录存在性：捕获结构不得保存 Authorization 值或 key 内容。
      expect(Object.values(captured).some((v) => typeof v === "string" && v === captured.authorization)).toBe(true);
      const bodyText = captured.body.toString("latin1");
      expect(bodyText).toContain('name="file"');
      expect(bodyText).toContain('filename="sample.png"');
      expect(bodyText).toContain('name="purpose"');
      expect(bodyText).toContain("rich_layout_recognition");
      expect(bodyText).not.toContain("test-key-value"); // key 绝不进入请求体
      const fileFields = (bodyText.match(/name="[a-z]+"/g) ?? []).sort();
      expect([...new Set(fileFields)]).toEqual(['name="file"', 'name="purpose"']);
      expect(result).toMatchObject({
        id: "ocr-result-1", pageCount: 1, requestId: "req-123",
        pages: [{ index: 0, finishReason: "stop" }],
        usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
      });
      expect(result.pages[0]!.text).toContain("<｜box｜>"); // 原始文本忠实保留
      expect((result.raw as typeof SUCCESS).object).toBe("ocr.result");
    });
  });

  it("finish_reason=length 原样返回（截断由上层标 partial）", async () => {
    await withServer((_req, res) => {
      res.end(JSON.stringify({ ...SUCCESS, page_count: 2, pages: [
        { index: 0, text: "第一页", finish_reason: "stop" },
        { index: 1, text: "第二页被截断", finish_reason: "length" },
      ] }));
    }, async (endpoint) => {
      const result = await clientFor(endpoint).recognize(pngFile());
      expect(result.pages.map((p) => p.finishReason)).toEqual(["stop", "length"]);
    });
  });

  it("HTTP 200 携带 error 字段 → api_error（确定结果，不未知）", async () => {
    await withServer((_req, res) => {
      res.end(JSON.stringify({ error: { message: "unsupported image", type: "invalid_request_error", param: "file", code: "invalid_file" } }));
    }, async (endpoint) => {
      const error = await clientFor(endpoint).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(DeepSeekOcrError);
      expect(error.code).toBe("api_error");
      expect(error.outcomeUnknown).toBe(false);
      expect(error.apiErrorCode).toBe("invalid_file");
    });
  });

  it("页数不一致与索引缺失 → page_mismatch（结果未知：服务端可能已完成并计费）", async () => {
    await withServer((_req, res) => { res.end(JSON.stringify({ ...SUCCESS, page_count: 2 })); }, async (endpoint) => {
      const error = await clientFor(endpoint).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error.code).toBe("page_mismatch");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer((_req, res) => {
      res.end(JSON.stringify({ ...SUCCESS, page_count: 2, pages: [
        { index: 0, text: "a", finish_reason: "stop" }, { index: 2, text: "b", finish_reason: "stop" },
      ] }));
    }, async (endpoint) => {
      const error = await clientFor(endpoint).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error.code).toBe("page_mismatch");
      expect(error.outcomeUnknown).toBe(true);
    });
  });

  it("HTTP 200 后空响应/无效 JSON/不符合 schema → 结果未知（服务端可能已完成并计费）", async () => {
    await withServer((_req, res) => { res.end(""); }, async (endpoint) => {
      const error = await clientFor(endpoint).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_json");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer((_req, res) => { res.end("not-json"); }, async (endpoint) => {
      const error = await clientFor(endpoint).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_json");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer((_req, res) => { res.end(JSON.stringify({ id: "x", object: "ocr.result" })); }, async (endpoint) => {
      const error = await clientFor(endpoint).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_schema");
      expect(error.outcomeUnknown).toBe(true);
    });
  });

  it("402 = insufficient_balance；429/5xx 不自动重试（只调用一次）", async () => {
    let calls402 = 0;
    await withServer((_req, res) => {
      calls402++;
      res.statusCode = 402;
      res.end(JSON.stringify({ error: { message: "Balance is not enough", type: "billing_error", code: "insufficient_balance" } }));
    }, async (endpoint) => {
      const error = await clientFor(endpoint).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(DeepSeekOcrError);
      expect(error.code).toBe("insufficient_balance");
      expect(error.httpStatus).toBe(402);
      expect(error.outcomeUnknown).toBe(false);
      expect(calls402).toBe(1);
    });
    for (const status of [429, 500]) {
      let calls = 0;
      await withServer((_req, res) => { calls++; res.statusCode = status; res.end(JSON.stringify({ error: { message: "busy" } })); }, async (endpoint) => {
        const error = await clientFor(endpoint).recognize(pngFile()).then(() => undefined, (e) => e);
        expect(["rate_limited", "http_error"]).toContain(error.code);
        expect(error.outcomeUnknown).toBe(false);
        expect(calls).toBe(1); // 绝不自动重试
      });
    }
  });

  it("取消与超时 → outcomeUnknown=true（服务端可能继续处理并计费）", async () => {
    await withServer(() => { /* 永远不应答 */ }, async (endpoint) => {
      const slow = clientFor(endpoint, { timeoutMs: 150 });
      const error = await slow.recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(DeepSeekOcrError);
      expect(error.code).toBe("timeout");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer(() => { /* 永远不应答 */ }, async (endpoint) => {
      const controller = new AbortController();
      const pending = clientFor(endpoint, { timeoutMs: 10_000 }).recognize(pngFile(), { signal: controller.signal });
      setTimeout(() => controller.abort(), 60);
      const error = await pending.then(() => undefined, (e) => e);
      expect(error.code).toBe("cancelled");
      expect(error.outcomeUnknown).toBe(true);
    });
  });

  it("HTTP 200 响应读取途中取消/超时 → 保持 outcomeUnknown=true（readBody 阶段，服务端可能已完成并计费）", async () => {
    // 服务器已返回 200 响应头并写入部分 JSON 正文，随后挂起。
    const hangAfterPartial = (res: import("node:http").ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("\n{\"id\":\"ocr-parti");
      // 不 end：模拟识别中流式挂起
    };
    await withServer((_req, res) => hangAfterPartial(res), async (endpoint) => {
      const controller = new AbortController();
      const pending = clientFor(endpoint, { timeoutMs: 10_000 }).recognize(pngFile(), { signal: controller.signal });
      setTimeout(() => controller.abort(), 60);
      const error = await pending.then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(DeepSeekOcrError);
      expect(error.code).toBe("cancelled");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer((_req, res) => hangAfterPartial(res), async (endpoint) => {
      const error = await clientFor(endpoint, { timeoutMs: 150 }).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(DeepSeekOcrError);
      expect(error.code).toBe("timeout");
      expect(error.outcomeUnknown).toBe(true);
    });
  });

  it("非 2xx 错误正文读取途中取消/超时 → 保持 outcomeUnknown=true，不得当作确定 HTTP 错误", async () => {
    const hangErrorBody = (res: import("node:http").ServerResponse) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.write("{\"error\":{\"message\":\"par");
      // 不 end：错误正文只发了一半
    };
    await withServer((_req, res) => hangErrorBody(res), async (endpoint) => {
      const controller = new AbortController();
      const pending = clientFor(endpoint, { timeoutMs: 10_000 }).recognize(pngFile(), { signal: controller.signal });
      setTimeout(() => controller.abort(), 60);
      const error = await pending.then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(DeepSeekOcrError);
      expect(error.code).toBe("cancelled");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer((_req, res) => hangErrorBody(res), async (endpoint) => {
      const error = await clientFor(endpoint, { timeoutMs: 150 }).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(DeepSeekOcrError);
      expect(error.code).toBe("timeout");
      expect(error.outcomeUnknown).toBe(true);
    });
  });

  it("已发起后连接失败 → outcomeUnknown=true", async () => {
    const client = new DeepSeekOcrClient({
      endpoint: "http://127.0.0.1:1/v1/tools/ocr", fetch: globalThis.fetch,
      getApiKey: () => "test-key-value", timeoutMs: 5_000,
    });
    const error = await client.recognize(pngFile()).then(() => undefined, (e) => e);
    expect(error).toBeInstanceOf(DeepSeekOcrError);
    expect(error.code).toBe("connection_failed");
    expect(error.outcomeUnknown).toBe(true);
  });

  it("响应超过大小上限 → response_too_large（结果未知）", async () => {
    await withServer((_req, res) => { res.end("\n" + JSON.stringify({ ...SUCCESS, pages: [{ index: 0, text: "x".repeat(4096), finish_reason: "stop" }] })); }, async (endpoint) => {
      const error = await clientFor(endpoint, { maxResponseBytes: 512 }).recognize(pngFile()).then(() => undefined, (e) => e);
      expect(error.code).toBe("response_too_large");
      expect(error.outcomeUnknown).toBe(true);
    });
  });

  it("上传前校验失败是确定结果：扩展名/空文件/超过100MiB；生产默认只允许官方 URL", async () => {
    const client = new DeepSeekOcrClient({ getApiKey: () => "test-key-value" });
    const bad = join(root, "notes.md");
    writeFileSync(bad, "# text");
    await expect(client.recognize(bad)).rejects.toMatchObject({ code: "unsupported_file", outcomeUnknown: false });
    const empty = join(root, "empty.png");
    writeFileSync(empty, "");
    await expect(client.recognize(empty)).rejects.toMatchObject({ code: "empty_file", outcomeUnknown: false });
    const big = join(root, "big.pdf");
    writeFileSync(big, Buffer.alloc(100 * 1024 * 1024 + 1));
    await expect(client.recognize(big)).rejects.toMatchObject({ code: "file_too_large", outcomeUnknown: false });
    // 自定义端点必须注入 fetch（测试专用）；生产默认只允许官方 URL。
    expect(() => new DeepSeekOcrClient({ endpoint: "http://127.0.0.1:9/ocr" })).toThrow(/官方 URL/);
  });

  it("缺少凭据环境变量 → 确定失败，不匿名降级", async () => {
    const client = new DeepSeekOcrClient();
    const error = await client.recognize(pngFile()).then(() => undefined, (e) => e);
    expect(error).toBeInstanceOf(DeepSeekOcrError);
    expect(error.code).toBe("missing_api_key");
    expect(error.outcomeUnknown).toBe(false);
    expect(error.message).toContain("DEEPSEEK_API_KEY");
  });
});
