import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { DEEPSEEK_SEARCH_BILLABLE_UNIT_YUAN, DEEPSEEK_SEARCH_PRICE_BASIS, DeepSeekSearchClient, DeepSeekSearchError } from "../src/providers/deepseek-search.js";

type Handler = (req: { path: string; body: unknown; auth: string | undefined }, res: import("node:http").ServerResponse) => void;
async function localServer(handler: Handler) {
  const received: Array<{ path: string; body: unknown; auth: string | undefined }> = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const entry = { path: req.url!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, auth: req.headers.authorization };
    received.push(entry);
    handler(entry, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const client = new DeepSeekSearchClient({ getApiKey: () => "sk-test-offline-key", endpoint: base, fetch: ((url: string, init?: RequestInit) => fetch(url, init)) as typeof globalThis.fetch });
  const close = async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((e) => e ? reject(e) : done())); };
  return { client, received, base, close };
}
const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };

describe("DeepSeek Search/Fetch 受控 HTTP 适配", () => {
  it("search 成功：协议、校验与结构化结果（untrustedExternalData），URL 经公开 HTTPS 核验", async () => {
    const { client, received, close } = await localServer((entry, res) => json(res, 200, { results: [
      { title: "Official", url: "https://example.com/q1", snippet: "snippet", summary: "summary", content: "content", extra: "ignored" },
      { title: "Bad", url: "http://internal.example/q2" },
    ] }));
    try {
      const results = await client.search({ query: "official problems", count: 5 });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ title: "Official", url: "https://example.com/q1", snippet: "snippet", summary: "summary", content: "content", untrustedExternalData: true });
      expect(received[0]).toMatchObject({ path: "/v1/tools/search", body: { query: "official problems", count: 5, need_content: false }, auth: "Bearer sk-test-offline-key" });
    } finally { await close(); }
  });
  it("need_content 默认 false；空 results 合法；count 不影响价格常量", async () => {
    const { client, received, close } = await localServer((entry, res) => json(res, 200, entry.path === "/v1/tools/search" ? { results: [] } : { title: "t", content: "c" }));
    try {
      expect(await client.search({ query: "nothing found" })).toEqual([]);
      expect(received[0]?.body).toMatchObject({ count: 10, need_content: false });
      expect(DEEPSEEK_SEARCH_BILLABLE_UNIT_YUAN).toBe(0.005);
      expect(DEEPSEEK_SEARCH_PRICE_BASIS).toBe("official_list_price_estimate");
    } finally { await close(); }
  });
  it("searchDetailed 返回 providerResultCount（URL 过滤前的原始 results 长度），search 保持数组兼容", async () => {
    const { client, close } = await localServer((_entry, res) => json(res, 200, { results: [
      { title: "Official", url: "https://example.com/q1" },
      { title: "Bad", url: "http://internal.example/q2" },
    ] }));
    try {
      const detailed = await client.searchDetailed({ query: "x" });
      expect(detailed.providerResultCount).toBe(2);
      expect(detailed.results).toHaveLength(1);
      expect(detailed.results[0]).toMatchObject({ url: "https://example.com/q1", untrustedExternalData: true });
      expect(await client.search({ query: "x" })).toEqual(detailed.results);
    } finally { await close(); }
  });
  it("严格校验 Unicode 长度与 count，请求前拒绝", async () => {
    const { client, received, close } = await localServer((_entry, res) => json(res, 200, { results: [] }));
    try {
      const long = "题".repeat(129);
      await expect(client.search({ query: long })).rejects.toThrow();
      await expect(client.search({ query: "题".repeat(128) })).resolves.toEqual([]);
      await expect(client.search({ query: "x", count: 0 })).rejects.toThrow();
      await expect(client.search({ query: "x", count: 51 })).rejects.toThrow();
      await expect(client.search({ query: "   " })).rejects.toThrow();
      expect(received).toHaveLength(1); // 只有 128 字符那条真正发出
    } finally { await close(); }
  });
  it("fetch 成功返回 title/content/truncated；响应明确 truncated 时保留", async () => {
    const { client, received, close } = await localServer((entry, res) => json(res, 200, entry.body && (entry.body as { url: string }).url.includes("full")
      ? { title: "Full", content: "完整正文" } : { title: "Part", content: "部分正文", truncated: true }));
    try {
      expect(await client.fetchPage("https://example.com/full")).toMatchObject({ title: "Full", content: "完整正文", truncated: false });
      expect(await client.fetchPage("https://example.com/part")).toMatchObject({ title: "Part", truncated: true });
      expect(received.map((entry) => entry.path)).toEqual(["/v1/tools/fetch", "/v1/tools/fetch"]);
      expect(received[0]?.body).toEqual({ url: "https://example.com/full" });
    } finally { await close(); }
  });
  it("空 content 视为不完整失败（确定结果、不计费口径）", async () => {
    const { client, close } = await localServer((_entry, res) => json(res, 200, { title: "Empty", content: "  " }));
    try {
      const error = await client.fetchPage("https://example.com/empty").catch((e) => e as DeepSeekSearchError);
      expect(error).toBeInstanceOf(DeepSeekSearchError);
      expect(error.code).toBe("empty_content"); expect(error.outcomeUnknown).toBe(false); expect(error.httpStatus).toBe(200);
    } finally { await close(); }
  });
  it("HTTP 200 的 error 对象是确定拒绝；invalid JSON / schema 为结果未知", async () => {
    const apiError = await localServer((_entry, res) => json(res, 200, { error: { message: "bad request", type: "invalid_request_error", param: null, code: "invalid" } }));
    const failed = await apiError.client.search({ query: "x" }).catch((e) => e as DeepSeekSearchError);
    expect(failed.code).toBe("api_error"); expect(failed.outcomeUnknown).toBe(false); expect(failed.apiErrorCode).toBe("invalid");
    await apiError.close();
    const badJson = await localServer((_entry, res) => res.end("not-json"));
    const invalid = await badJson.client.search({ query: "x" }).catch((e) => e as DeepSeekSearchError);
    expect(invalid.code).toBe("invalid_json"); expect(invalid.outcomeUnknown).toBe(true);
    await badJson.close();
    const badSchema = await localServer((_entry, res) => json(res, 200, { results: "nope" }));
    const schema = await badSchema.client.search({ query: "x" }).catch((e) => e as DeepSeekSearchError);
    expect(schema.code).toBe("invalid_schema"); expect(schema.outcomeUnknown).toBe(true);
    await badSchema.close();
  });
  it("402 余额不足、429 限流、408 超时、5xx 均为确定结果且无自动重试", async () => {
    for (const [status, code] of [[402, "insufficient_balance"], [429, "rate_limited"], [408, "request_timeout"], [500, "http_error"]] as const) {
      const { client, received, close } = await localServer((_entry, res) => json(res, status, { error: { message: "upstream", code: "x" } }));
      const error = await client.search({ query: "x" }).catch((e) => e as DeepSeekSearchError);
      expect(error.code).toBe(code); expect(error.outcomeUnknown).toBe(false); expect(error.httpStatus).toBe(status);
      expect(received).toHaveLength(1); // 没有自动重试
      await close();
    }
  });
  it("取消与超时是结果未知，各只发一次请求", async () => {
    const hanging = await localServer((_entry, _res) => { /* never respond */ });
    const controller = new AbortController(); controller.abort();
    const cancelled = await hanging.client.search({ query: "x" }, { signal: controller.signal }).catch((e) => e as DeepSeekSearchError);
    expect(cancelled.code).toBe("cancelled"); expect(cancelled.outcomeUnknown).toBe(true);
    expect(hanging.received).toHaveLength(0); // 已取消，未发送
    await hanging.close();
    const slow = await localServer((_entry, _res) => { /* never respond */ });
    const timedOut = await new DeepSeekSearchClient({ getApiKey: () => "sk-test-offline-key", endpoint: slow.base, timeoutMs: 30, fetch: ((url: string, init?: RequestInit) => fetch(url, init)) as typeof globalThis.fetch }).search({ query: "x" }).catch((e) => e as DeepSeekSearchError);
    expect(["timeout", "cancelled"]).toContain(timedOut.code); expect(timedOut.outcomeUnknown).toBe(true);
    expect(slow.received).toHaveLength(1); // 超时后没有重试
    await slow.close();
  });
  it("响应超过大小上限为结果未知且不重试", async () => {
    const { received, base, close } = await localServer((_entry, res) => json(res, 200, { results: [{ title: "t", url: "https://example.com/a" }] }));
    const small = new DeepSeekSearchClient({ getApiKey: () => "sk-test-offline-key", endpoint: base, maxResponseBytes: 16, fetch: ((url: string, init?: RequestInit) => fetch(url, init)) as typeof globalThis.fetch });
    const error = await small.search({ query: "x" }).catch((e) => e as DeepSeekSearchError);
    expect(error.code).toBe("response_too_large"); expect(error.outcomeUnknown).toBe(true);
    expect(received).toHaveLength(1);
    await close();
  });
  it("fetch 只接受公开 HTTPS；带凭据/内网/敏感参数地址在请求前拒绝", async () => {
    let calls = 0;
    const { client, close } = await localServer((_entry, res) => { calls++; json(res, 200, { title: "t", content: "c" }); });
    for (const url of ["http://example.com/a", "https://127.0.0.1/a", "https://10.0.0.1/a", "https://me:pw@example.com/a", "https://example.com/a?api_key=secret"]) {
      const error = await client.fetchPage(url).catch((e) => e as DeepSeekSearchError);
      expect(error.code).toBe("invalid_url"); expect(error.outcomeUnknown).toBe(false);
    }
    expect(calls).toBe(0);
    await close();
  });
  it("凭据值不进入错误信息；未配置 Key 拒绝匿名", async () => {
    const secret = "sk-super-secret-value";
    const { client, close } = await localServer((_entry, res) => json(res, 500, { error: { message: `crash ${secret}`, code: "x" } }));
    let message = ""; try { await client.search({ query: "x" }); } catch (e) { message = String(e as Error); }
    expect(message).not.toContain(secret);
    await close();
    const anonymous = new DeepSeekSearchClient({ apiKeyEnv: "MEIKO_TEST_ABSENT_SEARCH_KEY", endpoint: "http://127.0.0.1:9", fetch: ((url: string, init?: RequestInit) => fetch(url, init)) as typeof globalThis.fetch });
    delete process.env.MEIKO_TEST_ABSENT_SEARCH_KEY;
    const error = await anonymous.search({ query: "x" }).catch((e) => e as DeepSeekSearchError);
    expect(error.code).toBe("missing_api_key"); expect(error.outcomeUnknown).toBe(false);
  });
  it("生产端点白名单：自定义 base 必须注入 fetch", () => {
    expect(() => new DeepSeekSearchClient({ endpoint: "http://127.0.0.1:9" })).toThrow("官方 URL");
    expect(() => new DeepSeekSearchClient({ endpoint: "http://127.0.0.1:9", fetch: ((url: string, init?: RequestInit) => fetch(url, init)) as typeof globalThis.fetch })).not.toThrow();
  });
});
