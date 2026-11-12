import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type ImageContent } from "@earendil-works/pi-ai";
import { importDataset } from "../dataset/import.js";
import { loadQuestionImages } from "../dataset/question-images.js";
import { buildUserContent } from "../runner/prompt.js";
import { ModelProfileSchema } from "../shared/contracts.js";
import { sha256OfJsonable } from "../shared/hashing.js";
import { OFFLINE_DEMO_PROVIDER } from "../shared/offline-demo.js";
import type { Registry } from "./pi-adapter.js";

const responses: Readonly<Record<string, string>> = {
  "demo-chemistry": "Answer: C\n丙的 pH 为 10，高于常温下中性的 pH 7。",
  "demo-figure": "Answer: B\n图中 B 组的柱形最高。",
  "demo-physics": "Answer: 3 m/s^2\n由牛顿第二定律，加速度为合力除以质量。",
  "demo-rain-day": "Answer: B\n6 月 2 日的降雨量是 15 mm，在三天中最大。",
  "demo-rain-total": "Answer: 30 mm\n三天的降雨量合计为 8 + 15 + 7 = 30 mm。",
  "demo-sequence": [
    "(a) 数列从 4 开始，相邻两项相差 3。",
    "从首项到第 n 项一共增加 n - 1 次。",
    "因此通项为 a_n = 4 + 3(n - 1)。",
    "取 n = 6，有 a_6 = 4 + 3 × 5 = 19。",
    "",
    "(b) 写出前六项：4、7、10、13、16、19。",
    "首末配对：4 + 19 = 23。",
    "第二项和倒数第二项：7 + 16 = 23。",
    "中间两项：10 + 13 = 23。",
    "共三组，前六项之和为 3 × 23 = 69。",
  ].join("\n"),
};

function payloadDigest(text: string, images: ImageContent[]): string {
  return sha256OfJsonable({ text: text.replace(/\r\n/g, "\n"), images });
}

/** 只匹配原样的公开示例题。评分文件由原有判分流程独立读取。 */
export async function createDemoRegistry(sourcePath: string, tokensPerSecond = 30): Promise<Registry> {
  const publicDir = join(sourcePath, "public");
  const bundle = await importDataset({ datasetId: "demo", publicDir });
  if (!bundle.ok || bundle.entries.length !== Object.keys(responses).length) {
    throw new Error("随附示例题包不完整，请检查 datasets/demo。");
  }
  const questionByPayload = new Map<string, string>();
  for (const entry of bundle.entries) {
    if (!entry.question || !Object.hasOwn(responses, entry.questionId)) throw new Error(`没有对应的演示题：${entry.questionId}`);
    const images = await loadQuestionImages(entry.question, publicDir);
    questionByPayload.set(payloadDigest(buildUserContent(entry.question), images), entry.questionId);
    questionByPayload.set(payloadDigest(buildUserContent(entry.question, { includeAssetRefs: true }), images), entry.questionId);
  }

  const profile = ModelProfileSchema.parse({
    id: OFFLINE_DEMO_PROVIDER, displayName: "离线演示（本机）", provider: OFFLINE_DEMO_PROVIDER,
    api: "faux", baseUrl: "local://meiko-offline-demo",
    auth: { envVars: ["MEIKO_OFFLINE_DEMO_UNUSED"] },
    models: [{ id: "scripted-v1", name: "脚本作答", input: ["text", "image"], contextWindow: 32768, maxTokens: 4096 }],
  });
  const faux = fauxProvider({ provider: profile.provider, models: profile.models, tokensPerSecond });
  const answer: FauxResponseFactory = (context) => {
    const user = context.messages.find((message) => message.role === "user");
    const content = user?.content ?? "";
    const text = typeof content === "string" ? content : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    const images = typeof content === "string" ? [] : content.filter((block) => block.type === "image");
    const questionId = questionByPayload.get(payloadDigest(text, images));
    if (!questionId) throw new Error("离线演示只支持未修改的随附题面和原图。");
    const calculation = context.messages.find((message) => message.role === "toolResult" && message.toolName === "calculate");
    if (calculation?.role === "toolResult") {
      const output = calculation.content.find((block) => block.type === "text");
      const value = output?.type === "text" ? /^result = (\S+)$/m.exec(output.text.replace(/\r\n/g, "\n"))?.[1] : undefined;
      if (calculation.isError || value === undefined || !Number.isFinite(Number(value))) {
        throw new Error("离线演示的计算工具未返回有效计算结果。");
      }
      return fauxAssistantMessage(`Answer: ${value} m/s^2\n计算工具计算了合力除以质量。`);
    }
    const canCalculate = context.messages.some((message) =>
      message.role === "system" && message.toolsAdded?.some((tool) => tool.name === "calculate"));
    if (questionId === "demo-physics" && canCalculate) {
      return fauxAssistantMessage(fauxToolCall("calculate", { expression: "12 / 4" }));
    }
    return fauxAssistantMessage(responses[questionId]!);
  };
  // 每次请求在调用底层流之前登记响应。并发和续跑不依赖题目出场顺序。
  const provider = faux.provider;
  const models = createModels();
  models.setProvider({
    ...provider,
    stream: (model, context, options) => {
      faux.appendResponses([answer]);
      return provider.stream(model, context, options);
    },
    streamSimple: (model, context, options) => {
      faux.appendResponses([answer]);
      return provider.streamSimple(model, context, options);
    },
  });
  return { models, profilesById: new Map([[profile.id, profile]]) };
}
