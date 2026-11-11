import { describe, expect, it } from "vitest";
import { AnySearchClient } from "../src/providers/anysearch.js";

const host = "example.com", source = `https://${host}/question`;
const reply = (type: number, data?: string, name = `${host}.`) => ({ Status: 0, TC: false,
  Question: [{ name: `${host}.`, type }], Answer: data ? [{ name, type, data }] : [] });

function fixture(local: string[] = ["198.18.1.69"], dnsOverride?: (type: number) => Response | Promise<Response>) {
  const dnsRequests: Array<{ url: URL; init?: RequestInit }> = [];
  let apiCalls = 0;
  const client = new AnySearchClient({ resolveHost: async () => local, getApiKey: () => "offline-private-search-value", timeoutMs: 1000,
    fetch: async (_url, init) => {
      apiCalls++; expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer offline-private-search-value");
      return Response.json({ data: { url: source, content: "What is two plus two?", content_type: "text/plain" } });
    },
    publicDnsFetch: async (input, init) => {
      const url = new URL(String(input)); dnsRequests.push({ url, init });
      const type = Number(url.searchParams.get("type"));
      return dnsOverride ? dnsOverride(type) : Response.json(reply(type, type === 1 ? "93.184.216.34" : "2606:4700:4700::1111"));
    },
  });
  return { client, dnsRequests, apiCalls: () => apiCalls };
}

describe("Fake-IP 来源地址复核", () => {
  it("检查两个地址族，DNS 不携带凭据；公开来源仍经真实适配器提取", async () => {
    const s = fixture(["198.18.1.69", "198.19.1.1"]);
    expect((await s.client.extract(source)).content).toBe("What is two plus two?");
    expect(s.apiCalls()).toBe(1); expect(s.dnsRequests).toHaveLength(2);
    for (const { url, init } of s.dnsRequests) {
      expect(url.origin + url.pathname).toBe("https://cloudflare-dns.com/dns-query");
      expect(url.searchParams.get("name")).toBe(host);
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ accept: "application/dns-json" });
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    }
  });
  it("公开系统解析不额外请求公共 DNS", async () => {
    const s = fixture(["93.184.216.34"]); await s.client.extract(source);
    expect(s.dnsRequests).toHaveLength(0); expect(s.apiCalls()).toBe(1);
  });
  it.each([[], ["10.0.0.1"], ["127.0.0.1"], ["198.18.1.1", "10.0.0.1"], ["198.18.1.1", "93.184.216.34"], ["::ffff:127.0.0.1"]].map((local) => ({ local })))("不为内网、空值或混合结果复核：$local", async ({ local }) => {
    const s = fixture(local); await expect(s.client.extract(source)).rejects.toThrow("内网");
    expect(s.dnsRequests).toHaveLength(0); expect(s.apiCalls()).toBe(0);
  });
  it.each(["https://198.18.1.1/a", "https://198.19.1.1/a", "https://127.0.0.1/a"]) ("不放行字面量受限地址：%s", async (url) => {
    const s = fixture(); await expect(s.client.extract(url)).rejects.toThrow(); expect(s.dnsRequests).toHaveLength(0); expect(s.apiCalls()).toBe(0);
  });
  it("复核结果含内网 IPv6 时拒绝，不只检查 IPv4", async () => {
    const s = fixture(undefined, (type) => Response.json(reply(type, type === 1 ? "93.184.216.34" : "fd00::1")));
    await expect(s.client.extract(source)).rejects.toThrow("内网"); expect(s.apiCalls()).toBe(0);
  });
  it("接受公开 CNAME 链；所有地址仍须公开", async () => {
    const s = fixture(undefined, (type) => Response.json({ ...reply(type), Answer: type === 1 ? [
      { name: `${host}.`, type: 5, data: "cdn.example.net." }, { name: "cdn.example.net.", type: 1, data: "93.184.216.34" },
    ] : [] }));
    await s.client.extract(source); expect(s.apiCalls()).toBe(1);
  });
  it.each([
    { ...reply(1), Status: 3 }, { ...reply(1), TC: true },
    { ...reply(1), Question: [{ name: "other.example.", type: 1 }] },
    reply(1, "not-an-ip"), reply(1, "93.184.216.34", "unrelated.example."),
    { ...reply(1), Answer: [{ name: `${host}.`, type: 5, data: "internal.local." }] },
  ])("拒绝不完整、错误或不对应的公共 DNS 响应", async (response) => {
    const s = fixture(undefined, () => Response.json(response));
    await expect(s.client.extract(source)).rejects.toThrow("公共 DNS 复核失败"); expect(s.apiCalls()).toBe(0);
  });
  it("公共 DNS 空记录不能作为公开地址证明", async () => {
    const s = fixture(undefined, (type) => Response.json(reply(type)));
    await expect(s.client.extract(source)).rejects.toThrow("内网"); expect(s.apiCalls()).toBe(0);
  });
  it("HTTP 错误、超大正文及不响应取消的 DNS 传输均不能触发提取", async () => {
    for (const response of [new Response("error", { status: 503 }), new Response("x".repeat(16385))]) {
      const s = fixture(undefined, () => response);
      await expect(s.client.extract(source)).rejects.toThrow("公共 DNS 复核失败"); expect(s.apiCalls()).toBe(0);
    }
    let apiCalls = 0;
    const client = new AnySearchClient({ timeoutMs: 20, resolveHost: async () => ["198.18.1.1"],
      publicDnsFetch: async () => new Promise(() => {}), fetch: async () => { apiCalls++; throw new Error("must not fetch"); } });
    await expect(client.extract(source)).rejects.toThrow("取消或超时"); expect(apiCalls).toBe(0);
  });
  it("取消发生在检查前时不请求 DNS 或提取", async () => {
    const s = fixture(), controller = new AbortController(); controller.abort();
    await expect(s.client.extract(source, controller.signal)).rejects.toThrow("取消");
    expect(s.dnsRequests).toHaveLength(0); expect(s.apiCalls()).toBe(0);
  });
});
