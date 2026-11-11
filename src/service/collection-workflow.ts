import { Type } from "@earendil-works/pi-ai";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { AnswerKind } from "../shared/contracts.js";
import type { CollectionSession, CollectionSource } from "../shared/collection.js";
import { publicSearchUrl, type SearchDomains } from "../providers/anysearch.js";

const text = () => Type.String({ minLength: 1 });
const id = () => Type.String({ pattern: "^[a-z0-9][a-z0-9_.-]{0,127}$" });
const version = () => Type.String({ pattern: "^[a-z0-9][a-z0-9_.-]{0,63}$" });
const kind = () => Type.Union(AnswerKind.options.map((value) => Type.Literal(value)));
const evidence = Type.Object({ sourceId: text(), quote: text(), location: text() }, { additionalProperties: false });
const strings = () => Type.Array(Type.String());
export const collectionCandidateArgs = Type.Object({ candidate: Type.Object({
  question: Type.Object({ id: id(), version: version(), subject: text(), answerKind: kind(), stem: text(),
    language: Type.Optional(text()), tags: Type.Optional(strings()),
    options: Type.Optional(Type.Record(Type.String(), text())),
    parts: Type.Optional(Type.Array(Type.Object({ label: text(), prompt: text() }, { additionalProperties: false }))),
    assets: Type.Array(Type.Unknown(), { maxItems: 0 }),
  }, { additionalProperties: false }),
  sourceId: text(), originalId: Type.Optional(text()), evidence: Type.Array(evidence, { minItems: 1 }),
  answerEvidence: Type.Optional(Type.Array(evidence)),
  scoring: Type.Optional(Type.Object({ questionId: id(), questionVersion: version(), scoringVersion: version(),
    answerKind: kind(), maxScore: Type.Number({ minimum: 0 }),
    reference: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.String())])),
    rubric: Type.Optional(Type.Array(Type.Object({ partLabel: Type.Optional(Type.String()), points: Type.Number({ minimum: 0 }),
      evidence: Type.Optional(Type.String()), acceptAlternatives: Type.Optional(strings()),
    }, { additionalProperties: false }))),
    tolerance: Type.Optional(Type.Number({ minimum: 0 })), units: Type.Optional(strings()),
    acceptableAlternatives: Type.Optional(strings()), reviewConditions: Type.Optional(Type.String()),
    deterministicLocked: Type.Optional(Type.Literal(false)),
  }, { additionalProperties: false })),
}, { additionalProperties: false }) }, { additionalProperties: false });

/** 完整领域响应留在存档；模型先选择标签，再按需读取完整参数，避免每轮重复携带无关说明。 */
export function collectionDomains(domains: SearchDomains, tag?: string): unknown {
  if (tag) {
    const selected = domains.flatMap((domain) => domain.sub_domains).find((item) => item.sub_domain === tag);
    if (!selected) throw new Error("所选领域标签不在已发现的目录中。");
    return selected;
  }
  return domains.map((domain) => ({ domain: domain.domain, sub_domains: domain.sub_domains.map((item) => ({
    sub_domain: item.sub_domain, description: item.description,
    requiredParams: Object.fromEntries(Object.entries(item.params).filter(([, info]) => info.required)),
    parameterDetails: "用 get_sub_domains 的 tag 参数查看完整说明；命中会话缓存，不重复请求服务。",
  })) }));
}

type Node = { type: string; value?: string; alt?: string; url?: string; identifier?: string; children?: Node[] };
const label = (node: Node): string => node.value ?? node.alt ?? (node.children ?? []).map(label).join("");
export function collectionSourceLinks(source: CollectionSource, limit = 20, contains = "") {
  const tree = unified().use(remarkParse).parse(source.content) as Node;
  const definitions = new Map<string, string>(), nodes: Node[] = [];
  const walk = (node: Node) => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
  walk(tree);
  for (const node of nodes) if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url);
  const seen = new Set<string>(), links: Array<{ title: string; url: string }> = [];
  let rejected = 0;
  for (const node of nodes) {
    const raw = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier ?? "") : undefined;
    if (!raw || raw.startsWith("#")) continue;
    let url: string;
    try { url = publicSearchUrl(new URL(raw, source.url).href); }
    catch { rejected++; continue; }
    if (url === source.url || seen.has(url)) continue;
    seen.add(url);
    const title = label(node);
    if (contains && !`${title} ${url}`.toLowerCase().includes(contains.toLowerCase())) continue;
    links.push({ title, url });
  }
  return { sourceId: source.id, sourceTruncated: source.truncated, links: links.slice(0, limit),
    matchingLinks: links.length, omitted: Math.max(0, links.length - limit), rejected,
    note: "链接只供导航，尚未提取正文；不能作为题目证据。" };
}

export function collectionProgress(session: CollectionSession) {
  const accepted = session.candidates.filter((candidate) => !candidate.issues.length).length;
  const target = session.config.targetCount ?? null;
  const remaining = target === null ? null : Math.max(0, target - accepted);
  const readable = session.sources.filter((source) => !source.truncated).length;
  const targetReached = remaining === 0;
  const next = targetReached ? "核对候选题和来源，选择后生成草稿。" : accepted > 0 ? "已有候选题可先核对；按原要求继续补足缺口。"
    : readable > 0 ? "已取得来源正文；目录页可用 source_links 定位题目详情，再提取和提交候选。"
    : session.counts.search > 0 ? "已找到来源链接；需要提取包含完整题干的详情页。" : "按学科、难度与来源要求搜索具体题目页面。";
  return { target, accepted, remaining, targetReached, readableSources: readable,
    blockedCandidates: session.candidates.length - accepted, canStage: accepted > 0,
    awaitingScoringReview: session.candidates.filter((candidate) => !!candidate.scoring).length,
    next, stopReason: session.error ?? null };
}
