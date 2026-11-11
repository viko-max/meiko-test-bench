import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { AnySearchClient, publicSearchUrl } from "../src/providers/anysearch.js";

describe("AnySearch 受控 HTTP 适配", () => {
  it("真实本地 HTTP 服务验证请求协议、领域参数及正文，不发送账户或密钥操作", async () => {
    const received: Array<{ path: string; body: unknown; client: unknown }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      received.push({ path: req.url!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, client: req.headers["x-anysearch-client"] });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 0, data: req.url!.startsWith("/v1/sub-domains") ? { domains: [{ domain: "academic", sub_domains: [] }] } : req.url === "/v1/search" ? { results: [{ title: "Official", url: "https://example.com/questions", snippet: "Preview" }] } : { url: "https://example.com/questions", title: "Official", content: "Complete question.", content_type: "text/plain" } }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const client = new AnySearchClient({ resolveHost: async () => ["93.184.216.34"], fetch: (url, init) => {
      const target = new URL(String(url)); expect(target.origin).toBe("https://api.anysearch.com");
      return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
    } });
    try {
      expect(await client.search({ query: "official problems", max_results: 2 })).toHaveLength(1);
      expect(await client.getSubDomains(["academic"])).toHaveLength(1);
      expect(await client.extract("https://example.com/questions")).toMatchObject({ content: "Complete question.", truncated: false });
      expect(received[0]).toMatchObject({ path: "/v1/search", body: { query: "official problems", max_results: 2 }, client: "skill/3.1.1" });
      expect(received[1]?.path).toBe("/v1/sub-domains?domain=academic");
      expect(received[2]?.body).toEqual({ url: "https://example.com/questions" });
    } finally { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((e) => e ? reject(e) : done())); }
  });
  it.each(["http://example.com/a", "https://127.0.0.1/a", "https://2130706433/a", "https://[::ffff:127.0.0.1]/a", "https://10.0.0.1/a", "https://example.local/a", "https://me:password@example.com/a", "https://example.com/a?api_key=secret"]) ("拒绝非公开或敏感地址 %s", (url) => expect(() => publicSearchUrl(url)).toThrow());
  it("拒绝内网 DNS、PDF 与重定向，不调用目标站点", async () => {
    let calls = 0;
    const client = new AnySearchClient({ resolveHost: async () => ["192.168.1.2"], fetch: async () => { calls++; throw new Error("must not fetch"); } });
    await expect(client.extract("https://example.com/a")).rejects.toThrow("内网");
    await expect(client.extract("https://example.com/a.pdf")).rejects.toThrow("PDF"); expect(calls).toBe(0);
    const redirected = new AnySearchClient({ resolveHost: async () => ["93.184.216.34"], fetch: async () => Response.json({ data: { url: "https://example.com/other", content: "x" } }) });
    await expect(redirected.extract("https://example.com/a")).rejects.toThrow("重定向");
  });
  it("服务端错误与自动返回的新凭据不进入异常正文", async () => {
    const secret = "as_sk_abcdefghijklmnopqrstuv";
    const client = new AnySearchClient({ fetch: async () => Response.json({ code: -1, message: secret, data: { auto_registered: { api_key: secret } } }) });
    let message = ""; try { await client.search({ query: "test" }); } catch (e) { message = String(e); }
    expect(message).toContain("请求被拒绝"); expect(message).not.toContain(secret);
  });
  it("限制响应字节，识别截断及无效 JSON", async () => {
    const tooLarge = new AnySearchClient({ maxResponseBytes: 10, fetch: async () => Response.json({ data: { results: [] } }) });
    await expect(tooLarge.search({ query: "test" })).rejects.toThrow("大小上限");
    const bad = new AnySearchClient({ fetch: async () => new Response("not-json") });
    await expect(bad.search({ query: "test" })).rejects.toThrow("JSON");
    const truncated = new AnySearchClient({ resolveHost: async () => ["2606:4700:4700::1111"], fetch: async () => Response.json({ data: { url: "https://example.com/a", content: "x".repeat(50000) } }) });
    expect((await truncated.extract("https://example.com/a")).truncated).toBe(true);
  });
  it("已连接但无数据的服务仍可超时；不响应取消的传输也不阻塞调用方", async () => {
    let calls = 0;
    const client = new AnySearchClient({ timeoutMs: 20, fetch: async () => { calls++; return new Response(new ReadableStream({ start() {} })); } });
    await expect(client.search({ query: "test" })).rejects.toThrow("取消或超时"); expect(calls).toBe(1);
    const controller = new AbortController(); controller.abort();
    await expect(client.search({ query: "test" }, controller.signal)).rejects.toThrow("取消"); expect(calls).toBe(1);
  });
});
