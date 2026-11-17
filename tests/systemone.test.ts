import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { DecisionProviderProfileSchema } from "../src/shared/decision.js";
import { SystemOneClient, SystemOneError, type DecisionQuestion } from "../src/providers/systemone.js";

let root: string;
beforeAll(() => {
  mkdirSync(resolve(".work"), { recursive: true });
  root = mkdtempSync(resolve(".work", "systemone-"));
});
afterEach(() => {
  delete process.env.TEST_DECISION_KEY; // 绝不读取真实凭据；测试只使用注入的假 key
});

interface Captured {
  method?: string;
  authorization?: string;
  contentType?: string;
  body: string;
  count: number;
}

async function withServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void, fn: (endpoint: string, captured: Captured) => Promise<void>): Promise<void> {
  const captured: Captured = { body: "", count: 0 };
  const server: Server = createServer((req, res) => {
    captured.method = req.method;
    captured.authorization = req.headers.authorization;
    captured.contentType = req.headers["content-type"] as string | undefined;
    captured.count += 1;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { captured.body = Buffer.concat(chunks).toString("utf8"); void handler(req, res); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}/v1/systemone`, captured);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
  }
}

const antProfile = (endpoint: string) =>
  DecisionProviderProfileSchema.parse({
    id: "ant-decision", displayName: "蚂蚁", baseUrl: endpoint, apiKeyEnv: "TEST_DECISION_KEY",
    model: "lingdt-decision-1.0", envelope: "ant", capabilities: ["choice", "noul", "multi-choice", "extract"], enabled: true,
  });
const xiangxinProfile = (endpoint: string) =>
  DecisionProviderProfileSchema.parse({
    id: "xiangxin-decision", displayName: "象信", baseUrl: endpoint, apiKeyEnv: "TEST_DECISION_KEY",
    model: "xiangxin-3.8", envelope: "standard", capabilities: ["choice", "noul", "span"], enabled: true,
  });
const clientFor = (profile: ReturnType<typeof antProfile>, extra: ConstructorParameters<typeof SystemOneClient>[1] = {}) =>
  new SystemOneClient(profile, { fetch: globalThis.fetch, getApiKey: () => "test-key-value", ...extra });

const FULL_QUESTIONS: DecisionQuestion[] = [
  { id: "conclusion_kind", type: "choice", question: "结论类型", options: ["explicit_single", "explicit_multiple", "no_conclusion", "insufficient_evidence"] },
  { id: "has_explicit_conclusion", type: "noul", question: "是否有明确最终结论" },
  { id: "selected_options", type: "multi-choice", question: "选择了哪些选项", options: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] },
  { id: "answer_evidence", type: "extract", question: "提取证据" },
];

const antOkBody = {
  errorCode: 0,
  model: "lingdt-decision-1.0",
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  answers: {
    conclusion_kind: { choice: "explicit_multiple", probabilities: { explicit_single: 0.1, explicit_multiple: 0.8, no_conclusion: 0.05, insufficient_evidence: 0.05 }, confidence: 0.9 },
    has_explicit_conclusion: { noul: 0.95, confidence: 0.9 },
    selected_options: {
      choices: ["A", "J"],
      probabilities: { A: 0.9, B: 0.01, C: 0.01, D: 0.01, E: 0.01, F: 0.01, G: 0.01, H: 0.01, I: 0.01, J: 0.85 },
      confidence: 0.88,
    },
    answer_evidence: {
      spans: [
        { type: "evidence", text: "最终选择 A 和 J", start: 0, end: 12, confidence: 0.9 },
        { type: "evidence", text: "故选 A、J", start: 20, end: 27, probabilities: { A: 0.9, J: 0.85 }, confidence: 0.8 },
      ],
      model_span_count: 2,
      truncated: false,
    },
  },
  warnings: ["sample warning"],
};

describe("SystemOneClient（真实 client 对本机 HTTP 测试服务）", () => {
  it("蚂蚁成功：errorCode=0 + answers/model/usage 完整；A 和 J 多选、warnings、请求体契约", async () => {
    await withServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("x-request-id", "req-decision-1");
      res.end(JSON.stringify(antOkBody));
    }, async (endpoint, captured) => {
      const result = await clientFor(antProfile(endpoint)).decide("最终选择 A 和 J。\n故选 A、J。", FULL_QUESTIONS);
      expect(captured.method).toBe("POST");
      expect(captured.authorization).toMatch(/^Bearer \S+$/);
      expect(captured.contentType).toContain("application/json");
      const request = JSON.parse(captured.body);
      expect(request.model).toBe("lingdt-decision-1.0");
      expect(request.state).toContain("最终选择 A 和 J");
      // 官方请求契约：questions 是以问题 id 为键的 questionDef 映射，绝不带内部数组字段。
      expect(Object.keys(request.questions)).toEqual(FULL_QUESTIONS.map((q) => q.id));
      for (const def of Object.values(request.questions) as Record<string, unknown>[]) {
        expect(def).not.toHaveProperty("id");
        expect(def).not.toHaveProperty("question");
        expect(def).not.toHaveProperty("options");
      }
      expect(request.questions.conclusion_kind).toEqual({
        type: "choice", instructions: "结论类型",
        criteria: { explicit_single: "explicit_single", explicit_multiple: "explicit_multiple", no_conclusion: "no_conclusion", insufficient_evidence: "insufficient_evidence" },
      });
      expect(request.questions.has_explicit_conclusion).toEqual({ type: "noul", instructions: "是否有明确最终结论" });
      expect(request.questions.selected_options).toEqual({
        type: "multi-choice", instructions: "选择了哪些选项",
        criteria: Object.fromEntries("ABCDEFGHIJ".split("").map((o) => [o, o])),
      });
      expect(request.questions.answer_evidence).toMatchObject({
        type: "extract", instructions: "提取证据",
        criteria: { answer_evidence: "支持最终结论的原文片段" },
      });
      expect(request.questions.answer_evidence.context).toContain("最终选择 A 和 J"); // extract 的 context=state
      expect(captured.body).not.toContain("test-key-value"); // key 绝不进入请求体
      expect(result.model).toBe("lingdt-decision-1.0");
      expect(result.requestId).toBe("req-decision-1");
      expect(result.warnings).toEqual(["sample warning"]);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      const multi = result.answers.selected_options;
      expect(multi.type === "multi-choice" && multi.choices).toEqual(["A", "J"]); // “A 和 J”两个选项
      const noul = result.answers.has_explicit_conclusion;
      expect(noul.type === "noul" && noul.value).toBe(0.95); // 官方 noul 字段 → 内部 value
      const extract = result.answers.answer_evidence;
      expect(extract.type === "extract" && extract.modelSpanCount).toBe(2);
      expect(extract.type === "extract" && extract.truncated).toBe(false);
      expect(result.raw).toEqual(antOkBody); // 安全响应原样保存
    });
  });

  it("象信成功：standard 信封无 errorCode；保存实际 model 与 x-xiangxin-model-ms/total-ms 头", async () => {
    await withServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("x-request-id", "req-xx-1");
      res.setHeader("x-xiangxin-model-ms", "321");
      res.setHeader("x-xiangxin-total-ms", "450");
      res.end(JSON.stringify({
        model: "xiangxin-3.8-real",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        answers: {
          conclusion_kind: { choice: "explicit_single", probabilities: { explicit_single: 0.9, explicit_multiple: 0.02, no_conclusion: 0.05, insufficient_evidence: 0.03 }, confidence: 0.91 },
          has_explicit_conclusion: { noul: 0.9 },
          answer_evidence_span: { spans: [{ path: "", start: 3, end: 8, text: "选 B 项", confidence: 0.8 }] },
        },
      }));
    }, async (endpoint, captured) => {
      const questions: DecisionQuestion[] = [
        { id: "conclusion_kind", type: "choice", question: "结论类型", options: ["explicit_single", "explicit_multiple", "no_conclusion", "insufficient_evidence"] },
        { id: "has_explicit_conclusion", type: "noul", question: "是否有明确最终结论" },
        { id: "answer_evidence_span", type: "span", question: "定位证据" },
      ];
      const result = await clientFor(xiangxinProfile(endpoint)).decide("最终选 B 项。", questions);
      expect(result.model).toBe("xiangxin-3.8-real"); // 保存实际响应 model
      expect(result.providerModelMs).toBe(321);
      expect(result.providerTotalMs).toBe(450);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      const span = result.answers.answer_evidence_span;
      expect(span.type === "span" && span.spans[0]).toMatchObject({ path: "", start: 3, end: 8, text: "选 B 项" });
      expect(captured.count).toBe(1);
    });
  });

  it("蚂蚁业务 errorCode!=0 → business_error（确定结果，不未知）", async () => {
    await withServer((_req, res) => {
      res.end(JSON.stringify({ errorCode: 1001, errorMsg: "invalid questions", model: "lingdt-decision-1.0", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, answers: {} }));
    }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(SystemOneError);
      expect(error.code).toBe("business_error");
      expect(error.outcomeUnknown).toBe(false);
      expect(error.apiErrorCode).toBe(1001);
    });
  });

  it("蚂蚁 errorCode!=0 即使缺 model/usage/answers 也是确定 business_error（errorDesc 优先于 errorMsg）", async () => {
    await withServer((_req, res) => {
      res.end(JSON.stringify({ errorCode: 1002, errorDesc: "questions invalid", errorMsg: "fallback msg" }));
    }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(SystemOneError);
      expect(error.code).toBe("business_error");
      expect(error.outcomeUnknown).toBe(false); // 绝不因缺 usage/answers 降级为 invalid_schema
      expect(error.apiErrorCode).toBe(1002);
      expect(error.message).toContain("questions invalid");
      expect(error.message).not.toContain("fallback msg");
    });
  });

  it("百炼 standard 信封：usage 可只有 input_tokens（unknown 字段不整单无效）；output 记 0、total=input+0，raw 保留原值", async () => {
    const bailianProfile = (endpoint: string) =>
      DecisionProviderProfileSchema.parse({
        id: "bailian-decision", displayName: "百炼", baseUrl: endpoint, apiKeyEnv: "TEST_DECISION_KEY",
        model: "decision-model-preview", envelope: "standard", capabilities: ["choice", "noul"], enabled: true,
      });
    await withServer((_req, res) => {
      res.end(JSON.stringify({
        model: "decision-model-preview",
        usage: { input_tokens: 42, unknown_field: "kept" },
        answers: {
          conclusion_kind: { choice: "explicit_single", probabilities: { explicit_single: 0.9, explicit_multiple: 0.05, no_conclusion: 0.03, insufficient_evidence: 0.02 }, confidence: 0.9 },
          has_explicit_conclusion: { noul: 0.8 },
        },
      }));
    }, async (endpoint) => {
      const result = await clientFor(bailianProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!, FULL_QUESTIONS[1]!]);
      expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 0, totalTokens: 42 }); // 缺失归一化
      const rawUsage = (result.raw as { usage: Record<string, unknown> }).usage;
      expect(rawUsage).not.toHaveProperty("output_tokens"); // raw 保留原值，不补零
      expect(rawUsage).not.toHaveProperty("total_tokens");
      expect(rawUsage.unknown_field).toBe("kept"); // unknown 字段可通过
    });
  });

  it("蚂蚁 usage 可缺 total_tokens：total=input+output 归一化，raw 保留原值", async () => {
    await withServer((_req, res) => {
      res.end(JSON.stringify({
        errorCode: 0, model: "m", usage: { input_tokens: 30, output_tokens: 20 },
        answers: { has_explicit_conclusion: { noul: 0.7 } },
      }));
    }, async (endpoint) => {
      const result = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[1]!]);
      expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 20, totalTokens: 50 });
      expect((result.raw as { usage: Record<string, unknown> }).usage).not.toHaveProperty("total_tokens");
    });
  });

  it("响应体包含当前凭据 → credential_leak 确定拒绝；错误消息绝不回显 key", async () => {
    await withServer((_req, res) => {
      res.end(JSON.stringify({ ...antOkBody, echo: "test-key-value" }));
    }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(SystemOneError);
      expect(error.code).toBe("credential_leak");
      expect(error.outcomeUnknown).toBe(false);
      expect(error.message).not.toContain("test-key-value");
    });
  });

  it("choice/multi-choice 答案里的 type 必须与请求一致，不符 → invalid_schema（结果未知）", async () => {
    await withServer((_req, res) => {
      res.end(JSON.stringify({
        errorCode: 0, model: "m", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        answers: { conclusion_kind: { type: "noul", choice: "explicit_single", probabilities: { explicit_single: 1 }, confidence: 0.5 } },
      }));
    }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_schema");
      expect(error.outcomeUnknown).toBe(true);
    });
  });

  it("402=余额不足、429=限流、408=服务端超时、5xx=http_error：均为确定结果且只调用一次", async () => {
    for (const [status, code] of [[402, "insufficient_balance"], [429, "rate_limited"], [408, "request_timeout"], [500, "http_error"]] as const) {
      let calls = 0;
      await withServer((_req, res) => {
        calls += 1;
        res.statusCode = status;
        res.end(JSON.stringify({ detail: `error ${status}` })); // 象信错误 HTTP detail
      }, async (endpoint) => {
        const error = await clientFor(xiangxinProfile(endpoint)).decide("x", [
          { id: "conclusion_kind", type: "choice", question: "结论类型", options: ["explicit_single", "explicit_multiple", "no_conclusion", "insufficient_evidence"] },
        ]).then(() => undefined, (e) => e);
        expect(error).toBeInstanceOf(SystemOneError);
        expect(error.code).toBe(code);
        expect(error.httpStatus).toBe(status);
        expect(error.message).toContain(`error ${status}`);
        expect(error.outcomeUnknown).toBe(false);
        expect(calls).toBe(1); // 绝不自动重试
      });
    }
  });

  it("HTTP 200 后空响应/无效 JSON/不符合 schema/缺答案/类型不符/noul 越界 → invalid_schema 或 invalid_json，结果未知", async () => {
    await withServer((_req, res) => { res.end(""); }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_json");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer((_req, res) => { res.end("not-json"); }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_json");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer((_req, res) => { res.end(JSON.stringify({ foo: 1 })); }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_schema");
      expect(error.outcomeUnknown).toBe(true);
    });
    // 每个请求问题都必须有对应答案：缺 noul 答案
    await withServer((_req, res) => {
      res.end(JSON.stringify({ ...antOkBody, answers: { conclusion_kind: antOkBody.answers.conclusion_kind } }));
    }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", FULL_QUESTIONS).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_schema");
      expect(error.outcomeUnknown).toBe(true);
      expect(error.message).toContain("has_explicit_conclusion");
    });
    // choice 不在候选选项内 / probabilities 缺项
    await withServer((_req, res) => {
      res.end(JSON.stringify({
        errorCode: 0, model: "m", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        answers: { conclusion_kind: { choice: "bogus", probabilities: { explicit_single: 1 }, confidence: 0.5 } },
      }));
    }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_schema");
      expect(error.outcomeUnknown).toBe(true);
    });
    // noul 越界（>1）
    await withServer((_req, res) => {
      res.end(JSON.stringify({
        errorCode: 0, model: "m", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        answers: { has_explicit_conclusion: { noul: 1.5 } },
      }));
    }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint)).decide("x", [FULL_QUESTIONS[1]!]).then(() => undefined, (e) => e);
      expect(error.code).toBe("invalid_schema");
      expect(error.outcomeUnknown).toBe(true);
    });
  });

  it("取消与超时 → outcomeUnknown=true；已发起后断连 → connection_failed（结果未知）", async () => {
    await withServer(() => { /* 永远不应答 */ }, async (endpoint) => {
      const error = await clientFor(antProfile(endpoint), { timeoutMs: 150 }).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
      expect(error.code).toBe("timeout");
      expect(error.outcomeUnknown).toBe(true);
    });
    await withServer(() => { /* 永远不应答 */ }, async (endpoint) => {
      const controller = new AbortController();
      const pending = clientFor(antProfile(endpoint), { timeoutMs: 10_000 }).decide("x", [FULL_QUESTIONS[0]!], { signal: controller.signal });
      setTimeout(() => controller.abort(), 60);
      const error = await pending.then(() => undefined, (e) => e);
      expect(error.code).toBe("cancelled");
      expect(error.outcomeUnknown).toBe(true);
    });
    const client = new SystemOneClient(antProfile("http://127.0.0.1:1/v1/systemone"), { fetch: globalThis.fetch, getApiKey: () => "test-key-value", timeoutMs: 5_000 });
    const error = await client.decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
    expect(error.code).toBe("connection_failed");
    expect(error.outcomeUnknown).toBe(true);
  });

  it("缺凭据环境变量 → 确定失败 missing_api_key；生产默认只允许 https 端点（注入 fetch 可本机）", async () => {
    // 用 https 但未注入凭据：构造器通过（https 允许），decide 在发请求前拒绝。
    const profile = antProfile("https://127.0.0.1:9/v1/systemone");
    const error = await new SystemOneClient(profile).decide("x", [FULL_QUESTIONS[0]!]).then(() => undefined, (e) => e);
    expect(error).toBeInstanceOf(SystemOneError);
    expect(error.code).toBe("missing_api_key");
    expect(error.outcomeUnknown).toBe(false);
    expect(error.message).toContain("TEST_DECISION_KEY");
    expect(() => new SystemOneClient(antProfile("http://127.0.0.1:9/v1/systemone"))).toThrow(/https/);
    // 注入 fetch 是测试专用出口（本机 HTTP）
    expect(() => new SystemOneClient(antProfile("http://127.0.0.1:9/v1/systemone"), { fetch: globalThis.fetch, getApiKey: () => "k" })).not.toThrow();
    // 任意 https 端点允许（百炼等用户配置完整 URL）
    expect(() => new SystemOneClient(antProfile("https://custom.example/v1/systemone"))).not.toThrow();
  });
});
