/**
 * 讯飞星火 MaaS 的供应商原生网络搜索（provider-native web search）。
 *
 * 官方文档（2026-11-03 核对）：https://maas.xfyun.cn/doc/guide/3%E3%80%81API%20%E6%8E%A5%E5%8F%A3/3.1%20%E6%98%9F%E7%81%AB%E6%A8%A1%E5%9E%8B%20API/3.1.1%20Chat.html
 * 端点 https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions，模型 spark-x2.6，
 * 请求体 tools 传 {"type":"web_search","web_search":{"enable":true}}，tool_choice 默认为 auto。
 *
 * 这里只做两件事：判断某个模型档案是否允许打开原生搜索（严格白名单），以及把
 * 原生搜索参数注入已经构造好的请求载荷。文档核实只说明协议存在，不代表本
 * Harness 的真实搜索链路已经验收通过（AGENTS.md §10）。
 */
import type { ModelProfile } from "../shared/contracts.js";

export const SPARK_PROFILE_ID = "spark";
export const SPARK_PROVIDER_ID = "xfyun-spark";
export const SPARK_API = "openai-completions";
export const SPARK_MODEL_ID = "spark-x2.6";
export const SPARK_ORIGIN = "https://maas-api.cn-huabei-1.xf-yun.com";
export const SPARK_PATHS = ["/v2", "/v2/"] as const;

export interface NativeSearchSupport {
  supported: boolean;
  reason: string | null;
}

/** 判断模型档案是否在原生搜索白名单内；不在则给出具体的中文原因。 */
export function sparkNativeSearchSupport(profile: ModelProfile | undefined, modelId: string): NativeSearchSupport {
  if (!profile) return { supported: false, reason: "未找到该模型档案，无法确认原生搜索能力。" };
  if (profile.id !== SPARK_PROFILE_ID)
    return { supported: false, reason: `模型档案 ${profile.id} 不是星火官方档案 ${SPARK_PROFILE_ID}，原生搜索只对星火开放。` };
  if (profile.provider !== SPARK_PROVIDER_ID)
    return { supported: false, reason: `模型档案的 provider 是 ${profile.provider}，原生搜索只支持 ${SPARK_PROVIDER_ID}。` };
  if (profile.api !== SPARK_API)
    return { supported: false, reason: `模型档案的 api 是 ${profile.api}，原生搜索只支持 ${SPARK_API}。` };
  if (modelId !== SPARK_MODEL_ID)
    return { supported: false, reason: `模型 ${modelId} 未开放原生搜索，只有 ${SPARK_MODEL_ID} 开放。` };
  let url: URL;
  try { url = new URL(profile.baseUrl); }
  catch { return { supported: false, reason: `模型接口地址 ${profile.baseUrl} 无法解析，原生搜索只允许 ${SPARK_ORIGIN}。` }; }
  if (url.origin !== SPARK_ORIGIN)
    return { supported: false, reason: `模型接口地址 ${url.origin} 不是星火 MaaS 官方地址 ${SPARK_ORIGIN}。` };
  if (!(SPARK_PATHS as readonly string[]).includes(url.pathname))
    return { supported: false, reason: `模型接口路径 ${url.pathname} 不是 ${SPARK_PATHS.join(" 或 ")}。` };
  if (url.search) return { supported: false, reason: "模型接口地址带查询参数，原生搜索不接受这种地址。" };
  if (url.hash) return { supported: false, reason: "模型接口地址带片段（hash），原生搜索不接受这种地址。" };
  if (url.username || url.password) return { supported: false, reason: "模型接口地址带用户名或密码，原生搜索不接受这种地址。" };
  if (profile.capability.nativeWebSearch !== "verified")
    return { supported: false, reason: `模型档案的原生搜索能力状态是 ${profile.capability.nativeWebSearch}，未核实前不启用原生搜索。` };
  return { supported: true, reason: null };
}

const FUNCTION_TOOL_TYPES = new Set(["function", "FunctionCall"]);

function isFunctionTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") return false;
  const record = tool as Record<string, unknown>;
  if (typeof record.type === "string" && FUNCTION_TOOL_TYPES.has(record.type)) return true;
  return typeof record.function === "object" && record.function !== null;
}

/**
 * 把星火原生搜索参数注入请求载荷。只接受非数组的普通对象，返回浅拷贝：
 * tools 精确设为 [{type:"web_search",web_search:{enable:true}}]，tool_choice 设为 "auto"，
 * 其余字段原样保留。载荷里已有非空 tools 或函数工具时抛错，请求不会发出。
 */
export function injectSparkNativeSearch(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("原生搜索参数注入只接受请求载荷对象。");
  const source = payload as Record<string, unknown>;
  const tools = source.tools;
  if (tools !== undefined && tools !== null) {
    if (!Array.isArray(tools)) throw new Error("请求载荷的 tools 不是数组，不能安全注入原生搜索。");
    if (tools.some(isFunctionTool)) throw new Error("请求载荷已包含函数工具，不能与供应商原生搜索同时启用。");
    if (tools.length > 0) throw new Error("请求载荷已包含其他工具定义，不能与供应商原生搜索同时启用。");
  }
  return { ...source, tools: [{ type: "web_search", web_search: { enable: true } }], tool_choice: "auto" };
}
