import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import { EnvVarNameSchema } from "../shared/contracts.js";
import { assertNoCredentials } from "../shared/creds.js";

export const ANYSEARCH_VERSION = "3.1.1";
export const ANYSEARCH_COMMIT = "9b91ee215164de60d61c7d63789c891a1948b039";
const ENDPOINT = "https://api.anysearch.com";
const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [["2001:db8::", 32], ["2001::", 32], ["2002::", 16]] as const) blocked.addSubnet(ip, prefix, "ipv6");
const privateIp = (ip: string) => isIP(ip) === 4 ? blocked.check(ip, "ipv4") :
  isIP(ip) !== 6 || !globalV6.check(ip, "ipv6") || blocked.check(ip, "ipv6");
const fakeIps = new BlockList();
fakeIps.addSubnet("198.18.0.0", 15, "ipv4");
const fakeIp = (ip: string) => isIP(ip) === 4 && fakeIps.check(ip, "ipv4");
const dnsName = (name: string) => name.toLowerCase().replace(/\.$/, "");
const DnsReplySchema = z.object({
  Status: z.literal(0), TC: z.literal(false),
  Question: z.array(z.object({ name: z.string(), type: z.number().int() })).length(1),
  Answer: z.array(z.object({ name: z.string(), type: z.number().int(), data: z.string() })).max(64).default([]),
});

export function publicSearchUrl(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const ip = host.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
    (!host.includes(".") && !isIP(ip)) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
    (isIP(ip) !== 0 && privateIp(ip))) throw new Error("仅允许公开 HTTPS 来源地址，禁止本机、内网和带凭据的地址。");
  if ([...url.searchParams.keys()].some((key) => /token|secret|password|api.?key|authorization|signature/i.test(key))) throw new Error("来源地址含有敏感查询参数。");
  assertNoCredentials(raw, "source URL");
  url.hostname = host;
  url.hash = "";
  return url.href;
}

export const SearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(2000), tag: z.string().min(1).max(100).optional(),
  params: z.record(z.string(), z.string()).optional(), zone: z.enum(["cn", "intl"]).optional(),
  language: z.string().max(30).optional(), max_results: z.number().int().min(1).max(10).default(5),
}).strict();
export type SearchQuery = z.input<typeof SearchQuerySchema>;
const SearchResultSchema = z.object({ title: z.string().default(""), url: z.string(), content: z.string().optional(), snippet: z.string().optional() });
const DomainSchema = z.object({ domain: z.string(), sub_domains: z.array(z.object({
  sub_domain: z.string(), description: z.string().default(""),
  params: z.record(z.object({ required: z.boolean().optional(), description: z.string().optional(), sort_order: z.number().optional() })).default({}),
})) });
export type SearchDomains = z.infer<typeof DomainSchema>[];
export interface ExtractedPage { url: string; title: string; content: string; truncated: boolean; contentType: string | null }
export interface AnySearchOptions {
  getApiKey?: () => string | undefined;
  apiKeyEnv?: string; timeoutMs?: number; maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
  publicDnsFetch?: typeof globalThis.fetch;
  resolveHost?: (host: string) => Promise<string[]>;
}

export class AnySearchClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly publicDnsFetch: typeof globalThis.fetch;
  private readonly resolveHost: (host: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly keyEnv: string | undefined;
  private readonly getApiKey: (() => string | undefined) | undefined;
  constructor(options: AnySearchOptions = {}) {
    this.keyEnv = options.apiKeyEnv === undefined ? undefined : EnvVarNameSchema.parse(options.apiKeyEnv);
    this.getApiKey = options.getApiKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.publicDnsFetch = options.publicDnsFetch ?? globalThis.fetch;
    this.resolveHost = options.resolveHost ?? (async (host) => (await lookup(host, { all: true })).map((entry) => entry.address));
    this.timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? 30000);
    this.maxBytes = z.number().int().positive().max(4 * 1024 * 1024).parse(options.maxResponseBytes ?? 1024 * 1024);
  }
  private assertClean(value: unknown): void {
    assertNoCredentials(value, "AnySearch response");
    const key = this.getApiKey?.() ?? (this.keyEnv ? process.env[this.keyEnv] : undefined);
    if (key && JSON.stringify(value).includes(key)) throw new Error("AnySearch 返回内容包含当前密钥，已拒绝保存和展示。");
  }

  private async request(method: "GET" | "POST", path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    assertNoCredentials(payload, "AnySearch request");
    const key = this.getApiKey?.() ?? (this.keyEnv ? process.env[this.keyEnv] : undefined);
    if (this.keyEnv && !key) throw new Error(`未配置搜索凭据环境变量 ${this.keyEnv}；不会自动改用匿名身份。`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const onCancel = () => rejectCancelled(new Error("搜索已取消或超时；没有自动重试。"));
    controller.signal.addEventListener("abort", onCancel, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    const read = async () => {
      if (controller.signal.aborted) throw new Error("搜索已取消。");
      const response = await this.fetcher(ENDPOINT + path, {
        method, redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Anysearch-Client": `skill/${ANYSEARCH_VERSION}`,
          ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`AnySearch HTTP ${response.status}；请检查配额或配置，没有自动重试。`); }
      if (!response.body) throw new Error("AnySearch 返回空响应。");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > this.maxBytes) throw new Error("AnySearch 响应超过大小上限，拒绝作为完整材料使用。");
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      let json: unknown;
      try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new Error("AnySearch 返回的内容不是有效 JSON。"); }
      const envelope = z.object({ code: z.number().optional(), data: z.unknown() }).parse(json);
      // 不复制服务端错误正文或 auto_registered 等字段，它们可能带新凭据。
      if (envelope.code !== undefined && envelope.code !== 0) throw new Error("AnySearch 请求被拒绝；请检查配额、查询参数或凭据，没有自动重试。");
      return envelope.data;
    };
    try { return await Promise.race([read(), cancelled]); }
    catch (error) {
      controller.abort();
      if (error instanceof Error && /^(?:AnySearch|搜索)/.test(error.message) && (!key || !error.message.includes(key))) throw error;
      throw new Error("AnySearch 请求失败；服务端正文及凭据未写入日志，没有自动重试。");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", onCancel); }
  }

  async search(query: SearchQuery, signal?: AbortSignal) {
    const data = await this.request("POST", "/v1/search", SearchQuerySchema.parse(query), signal);
    const parsed = z.object({ results: z.array(SearchResultSchema) }).parse(data);
    const results = parsed.results.map((item) => ({ title: item.title, url: publicSearchUrl(item.url), snippet: item.content ?? item.snippet ?? "" }));
    this.assertClean(results);
    return results;
  }
  async getSubDomains(domains: string[], signal?: AbortSignal): Promise<SearchDomains> {
    z.array(z.string().regex(/^[a-z_]+$/)).min(1).max(5).parse(domains);
    const query = new URLSearchParams(domains.map((domain): [string, string] => ["domain", domain]));
    const result = z.object({ domains: z.array(DomainSchema) }).parse(await this.request("GET", `/v1/sub-domains?${query}`, {}, signal)).domains;
    this.assertClean(result);
    return result;
  }
  private async sourceAddresses(host: string, signal: AbortSignal): Promise<string[]> {
    if (signal.aborted) throw new Error("搜索地址检查已取消。");
    if (isIP(host)) return [host];
    const local = await this.resolveHost(host);
    // 仅对全部为 Fake-IP 的本地结果复核；内网、混合地址和解析失败不走第二条路径。
    if (!local.length || !local.every(fakeIp)) return local;
    const addresses: string[] = [];
    try {
      for (const type of [1, 28]) {
        const url = new URL("https://cloudflare-dns.com/dns-query");
        url.searchParams.set("name", host); url.searchParams.set("type", String(type));
        // DoH 使用独立传输与白名单请求头，绝不继承搜索或模型凭据。
        const response = await this.publicDnsFetch(url, { method: "GET", headers: { Accept: "application/dns-json" },
          signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
        if (!response.ok || response.redirected || !response.body) { await response.body?.cancel(); throw new Error("DNS response refused"); }
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength; if (size > 16384) throw new Error("DNS response too large");
            chunks.push(next.value);
          }
        } finally { await reader.cancel(); }
        const reply = DnsReplySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (dnsName(reply.Question[0]!.name) !== host || reply.Question[0]!.type !== type) throw new Error("DNS question mismatch");
        const names = new Set([host]);
        const aliases = reply.Answer.filter((record) => record.type === 5);
        for (let step = 0; step < aliases.length; step++) for (const alias of aliases) {
          if (!names.has(dnsName(alias.name))) continue;
          const target = dnsName(alias.data);
          if (new URL(publicSearchUrl(`https://${target}/`)).hostname !== target) throw new Error("DNS alias refused");
          names.add(target);
        }
        for (const record of reply.Answer) if (record.type === 1 || record.type === 28) {
          if (!names.has(dnsName(record.name)) || isIP(record.data) !== (record.type === 1 ? 4 : 6)) throw new Error("DNS address mismatch");
          addresses.push(record.data);
        }
      }
    } catch {
      throw new Error("搜索来源使用 Fake-IP，但公共 DNS 复核失败；请检查网络或 DNS 配置，正文提取请求未发送。");
    }
    return [...new Set(addresses)];
  }
  async extract(raw: string, signal?: AbortSignal): Promise<ExtractedPage> {
    const url = publicSearchUrl(raw);
    if (/\.(?:pdf|docx?|png|jpe?g|gif|webp|zip|mp[34])$/i.test(new URL(url).pathname)) throw new Error("搜索正文提取暂不支持 PDF、图片、Word 或其他二进制文件。");
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(stop, this.timeoutMs);
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      const addresses = await Promise.race([this.sourceAddresses(host, controller.signal), new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("搜索地址检查已取消或超时。")), { once: true });
        if (controller.signal.aborted) reject(new Error("搜索地址检查已取消。"));
      })]);
      if (!addresses.length || addresses.some(privateIp)) throw new Error("搜索来源解析为内网或暂不支持的地址，已拒绝提取。");
      const data = z.object({ url: z.string(), title: z.string().default(""), content: z.string().min(1),
        truncated: z.boolean().optional(), content_type: z.string().optional() }).parse(await this.request("POST", "/v1/extract", { url }, controller.signal));
      if (publicSearchUrl(data.url) !== url) throw new Error("搜索来源发生重定向，请核对最终公开地址后单独提取。");
      if (data.content_type && !/^(?:text\/(?:html|plain|markdown)|application\/(?:json|xhtml\+xml))(?:;|$)/i.test(data.content_type)) throw new Error("搜索正文返回了不支持的文件类型。");
      const result = { url, title: data.title, content: data.content, truncated: data.truncated === true || data.content.length >= 50000, contentType: data.content_type ?? null };
      this.assertClean(result);
      return result;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
  }
}
