import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDecisionFixture, FIXTURE_ANSWER, type DecisionFixture } from "./helpers/decision.js";
import { DecisionReviewService, resolveExtractOffset, verifyExtractEvidence, verifySpanEvidence } from "../src/service/decision-review.js";
import { ANT_DECISION_PROFILE, DecisionAssistanceRecordSchema, DecisionProviderProfileSchema, XIANGXIN_DECISION_PROFILE, type DecisionProviderProfile } from "../src/shared/decision.js";
import { SystemOneClient } from "../src/providers/systemone.js";

async function withServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void, fn: (endpoint: string, captured: { bodies: string[] }) => Promise<void>): Promise<void> {
  const captured = { bodies: [] as string[] };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { captured.bodies.push(Buffer.concat(chunks).toString("utf8")); void handler(req, res); });
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

const antProfileFor = (endpoint: string): DecisionProviderProfile =>
  DecisionProviderProfileSchema.parse({ ...ANT_DECISION_PROFILE, baseUrl: endpoint });
const xiangxinProfileFor = (endpoint: string): DecisionProviderProfile =>
  DecisionProviderProfileSchema.parse({ ...XIANGXIN_DECISION_PROFILE, baseUrl: endpoint });
const clientFor = (profile: DecisionProviderProfile, timeoutMs = 5_000) =>
  new SystemOneClient(profile, { fetch: globalThis.fetch, getApiKey: () => "test-key-value", timeoutMs });

function antBody(overrides: Record<string, unknown> = {}) {
  return {
    errorCode: 0, model: "lingdt-decision-1.0",
    usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120 },
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
          { type: "evidence", text: "最终选择 A 和 J", start: FIXTURE_ANSWER.indexOf("最终选择"), end: FIXTURE_ANSWER.indexOf("最终选择") + "最终选择 A 和 J".length, confidence: 0.9 },
        ],
        model_span_count: 1, truncated: false,
      },
    },
    ...overrides,
  };
}

const serviceFor = (fx: DecisionFixture) => new DecisionReviewService(fx.runsRoot, fx.datasetDir, fx.datasetId);
const assist = (fx: DecisionFixture, profile: DecisionProviderProfile, client: SystemOneClient) =>
  serviceFor(fx).assist({ runId: fx.runId, mode: "without_tool", trialId: fx.trialId, profile, client });

describe("DecisionReviewService（第二阶段 /review 决策辅助）", () => {
  it("蚂蚁完整成功：choice/noul/A和J多选/extract 证据，needsHumanReview 恒真，存档且 grade 字节不变", async () => {
    const fx = await buildDecisionFixture();
    await withServer((_req, res) => {
      res.setHeader("x-request-id", "req-1");
      res.end(JSON.stringify(antBody({ warnings: ["w1"] })));
    }, async (endpoint, captured) => {
      const gradeBefore = fx.gradeBytes();
      const record = await assist(fx, antProfileFor(endpoint), clientFor(antProfileFor(endpoint)));
      expect(record.status).toBe("completed");
      expect(record.needsHumanReview).toBe(true);
      expect(record.actualModel).toBe("lingdt-decision-1.0");
      expect(record.choice).toBe("explicit_multiple");
      expect(record.noul).toBe(0.95);
      expect(record.confidence).toBe(0.9);
      expect(record.probabilities).toMatchObject({ explicit_multiple: 0.8 });
      expect(record.selectedOptions).toEqual(["A", "J"]); // “A 和 J”两个选项
      expect(record.evidence).toHaveLength(1);
      expect(record.evidence[0]).toMatchObject({ quote: "最终选择 A 和 J", encoding: "utf16" });
      expect(FIXTURE_ANSWER.slice(record.evidence[0]!.start, record.evidence[0]!.end)).toBe("最终选择 A 和 J");
      expect(record.warnings).toEqual(["w1"]);
      expect(record.usage).toEqual({ inputTokens: 80, outputTokens: 40, totalTokens: 120 });
      expect(record.error).toBeNull();
      expect(record.limitations).toEqual(["profile ant-decision 无 span 能力，未发送原文证据定位问题。"]); // 显式 limitations，无静默降级
      expect(captured.bodies).toHaveLength(1); // 每次只发一次请求
      const request = JSON.parse(captured.bodies[0]!);
      expect(Object.keys(request.questions)).toEqual(["conclusion_kind", "has_explicit_conclusion", "selected_options", "answer_evidence"]);
      expect(request.questions.conclusion_kind.type).toBe("choice");
      // 结论四选项的描述由调用侧提供，criteria 值不得只是选项名本身。
      expect(request.questions.conclusion_kind.criteria.explicit_multiple).toBeTruthy();
      expect(request.questions.conclusion_kind.criteria.explicit_multiple).not.toBe("explicit_multiple");
      for (const def of Object.values(request.questions) as Record<string, unknown>[]) {
        expect(def).not.toHaveProperty("id");
        expect(def).not.toHaveProperty("question");
        expect(def).not.toHaveProperty("options");
      }
      // 追加 jsonl + 最新原子写；grade.json 字节完全不变。
      expect(existsSync(join(fx.trialDir, "decision-reviews.jsonl"))).toBe(true);
      expect(existsSync(join(fx.trialDir, "decision-review.json"))).toBe(true);
      expect(fx.gradeBytes()).toBe(gradeBefore);
      const latest = await serviceFor(fx).getLatest(fx.runId, fx.trialId);
      const history = await serviceFor(fx).getHistory(fx.runId, fx.trialId);
      expect(latest?.recordId).toBe(record.recordId);
      expect(history.map((r) => r.recordId)).toEqual([record.recordId]);
      DecisionAssistanceRecordSchema.parse(latest);
    });
  });

  it("能力缺失显式 limitations 而不静默降级：无 multi-choice 的蚂蚁变体不发送该问题", async () => {
    const fx = await buildDecisionFixture();
    await withServer((_req, res) => {
      res.end(JSON.stringify({
        errorCode: 0, model: "m", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        answers: {
          conclusion_kind: { choice: "explicit_single", probabilities: { explicit_single: 0.9, explicit_multiple: 0.05, no_conclusion: 0.03, insufficient_evidence: 0.02 }, confidence: 0.9 },
          has_explicit_conclusion: { noul: 0.9 },
        },
      }));
    }, async (endpoint, captured) => {
      const limited = DecisionProviderProfileSchema.parse({ ...ANT_DECISION_PROFILE, baseUrl: endpoint, capabilities: ["choice", "noul"] });
      const record = await assist(fx, limited, clientFor(limited));
      expect(record.status).toBe("completed");
      expect(record.limitations.join("；")).toContain("multi-choice");
      expect(record.limitations.join("；")).toContain("extract");
      const request = JSON.parse(captured.bodies[0]!);
      expect(Object.keys(request.questions)).toEqual(["conclusion_kind", "has_explicit_conclusion"]);
    });
  });

  it("象信 span：码点左闭右开校验并换算 UTF16（含 emoji），path 必须对应答卷", async () => {
    const fx = await buildDecisionFixture();
    const codepoints = Array.from(FIXTURE_ANSWER);
    const startCp = codepoints.indexOf("最");
    const text = "最终选择 A 和 J";
    await withServer((_req, res) => {
      res.setHeader("x-xiangxin-model-ms", "210");
      res.setHeader("x-xiangxin-total-ms", "300");
      res.end(JSON.stringify({
        model: "xiangxin-3.8", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        answers: {
          conclusion_kind: { choice: "explicit_multiple", probabilities: { explicit_single: 0.1, explicit_multiple: 0.85, no_conclusion: 0.03, insufficient_evidence: 0.02 }, confidence: 0.88 },
          has_explicit_conclusion: { noul: 0.92 },
          answer_evidence_span: { spans: [{ path: "", start: startCp, end: startCp + Array.from(text).length, text, confidence: 0.86 }] },
        },
      }));
    }, async (endpoint) => {
      const profile = xiangxinProfileFor(endpoint);
      const record = await assist(fx, profile, clientFor(profile));
      expect(record.status).toBe("completed");
      expect(record.providerModelMs).toBe(210);
      expect(record.providerTotalMs).toBe(300);
      expect(record.evidence[0]).toMatchObject({ quote: text, encoding: "codepoint", providerPath: "" });
      const expectedUtf16Start = FIXTURE_ANSWER.indexOf("最终选择");
      expect(record.evidence[0]!.start).toBe(expectedUtf16Start);
      expect(record.evidence[0]!.end).toBe(expectedUtf16Start + text.length);
      // 单元级：path 非空 → 定位失败
      expect(verifySpanEvidence("abc", { path: "other", start: 0, end: 1, text: "a" }).ok).toBe(false);
    });
  });

  it("象信无 multi-choice：从已验证原文证据中提取题面 A..Z 选项（A 和 J 两个选项及证据均可展示）", async () => {
    const fx = await buildDecisionFixture();
    const codepoints = Array.from(FIXTURE_ANSWER);
    const startCp = codepoints.indexOf("最");
    const text = "最终选择 A 和 J";
    await withServer((_req, res) => {
      res.end(JSON.stringify({
        model: "xiangxin-3.8", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        answers: {
          conclusion_kind: { choice: "explicit_multiple", probabilities: { explicit_single: 0.1, explicit_multiple: 0.85, no_conclusion: 0.03, insufficient_evidence: 0.02 }, confidence: 0.88 },
          has_explicit_conclusion: { noul: 0.92 },
          answer_evidence_span: { spans: [{ path: "", start: startCp, end: startCp + Array.from(text).length, text, confidence: 0.86 }] },
        },
      }));
    }, async (endpoint) => {
      const profile = xiangxinProfileFor(endpoint);
      const record = await assist(fx, profile, clientFor(profile));
      expect(record.status).toBe("completed");
      expect(record.selectedOptions).toEqual(["A", "J"]); // “A 和 J”逐项展示
      expect(record.evidence).toHaveLength(1); // 证据本身已验证，与选项一一可对照
      expect(record.limitations.join("；")).toContain("无 multi-choice 能力");
      expect(record.limitations.join("；")).toContain("已验证原文证据中提取");
      // 边界清晰：证据中未出现的题面选项不得入选。
      expect(record.selectedOptions).not.toContain("B");
    });
  });

  it("蚂蚁 multi-choice：模型选择但无已验证证据支持的选项不展示，列 limitations/unlocalized，grade 不变", async () => {
    const fx = await buildDecisionFixture();
    await withServer((_req, res) => {
      res.end(JSON.stringify(antBody({
        answers: {
          ...antBody().answers,
          // 证据 quote 不含任何题面选项标签：A 和 J 都缺少证据支持。
          answer_evidence: {
            spans: [{ type: "evidence", text: "计算过程略", start: FIXTURE_ANSWER.indexOf("计算过程略"), end: FIXTURE_ANSWER.indexOf("计算过程略") + 5, confidence: 0.8 }],
            model_span_count: 1, truncated: false,
          },
        },
      })));
    }, async (endpoint) => {
      const gradeBefore = fx.gradeBytes();
      const record = await assist(fx, antProfileFor(endpoint), clientFor(antProfileFor(endpoint)));
      expect(record.status).toBe("completed");
      expect(record.selectedOptions).toEqual([]); // 不得仅靠模型 choices 无证据展示
      expect(record.limitations.join("；")).toContain("A");
      expect(record.limitations.join("；")).toContain("缺少已验证原文证据支持");
      expect(record.unlocalizedEvidence.some((u) => u.reason.includes("缺少已验证原文证据支持"))).toBe(true);
      expect(record.evidence).toHaveLength(1); // 证据本身仍展示
      expect(fx.gradeBytes()).toBe(gradeBefore); // 原 grade 不变
    });
  });

  it("蚂蚁 extract 的 UTF8 字节 offset 被唯一解析并记录实际编码", async () => {
    const fx = await buildDecisionFixture();
    const text = "最终选择 A 和 J";
    const byteStart = Buffer.byteLength(FIXTURE_ANSWER.slice(0, FIXTURE_ANSWER.indexOf("最终选择")), "utf8");
    const byteEnd = byteStart + Buffer.byteLength(text, "utf8");
    await withServer((_req, res) => {
      res.end(JSON.stringify(antBody({
        answers: {
          ...antBody().answers,
          answer_evidence: { spans: [{ type: "evidence", text, start: byteStart, end: byteEnd, confidence: 0.8 }], model_span_count: 1, truncated: false },
        },
      })));
    }, async (endpoint) => {
      const record = await assist(fx, antProfileFor(endpoint), clientFor(antProfileFor(endpoint)));
      expect(record.evidence[0]).toMatchObject({ quote: text, encoding: "utf8" });
      expect(record.evidence[0]!.start).toBe(FIXTURE_ANSWER.indexOf("最终选择"));
    });
  });

  it("text/位置不符、重复歧义、truncated 都标定位失败并保留人工，不伪造坐标", async () => {
    // text 不符
    expect(verifyExtractEvidence("abc", { type: "evidence", text: "xyz", start: 0, end: 3 }).ok).toBe(false);
    // 重复歧义：answer="éaa"（é 占 1 个 UTF16 单位、2 个 UTF8 字节），providerStart=2,end=3：
    // UTF16 解释命中第二个 "a"（位置 2..3），UTF8 字节解释命中第一个 "a"（UTF16 位置 1..2）。
    const ambiguous = resolveExtractOffset("éaa", "a", 2, 3);
    expect(ambiguous.map((m) => m.encoding).sort()).toEqual(["utf16", "utf8"]);
    const ambiguousResult = verifyExtractEvidence("éaa", { type: "evidence", text: "a", start: 2, end: 3 });
    expect(ambiguousResult.ok).toBe(false);
    if (!ambiguousResult.ok) expect(ambiguousResult.reason).toContain("歧义");
    // truncated → 服务层记定位失败
    const fx = await buildDecisionFixture();
    await withServer((_req, res) => {
      res.end(JSON.stringify(antBody({
        answers: {
          ...antBody().answers,
          answer_evidence: { spans: [{ type: "evidence", text: "最终选择 A 和 J", start: FIXTURE_ANSWER.indexOf("最终选择"), end: FIXTURE_ANSWER.indexOf("最终选择") + 9, confidence: 0.8 }], model_span_count: 1, truncated: true },
        },
      })));
    }, async (endpoint) => {
      const record = await assist(fx, antProfileFor(endpoint), clientFor(antProfileFor(endpoint)));
      expect(record.status).toBe("completed"); // 仍可消费（人工核对），但证据不可信
      expect(record.needsHumanReview).toBe(true);
      expect(record.evidence).toEqual([]);
      expect(record.unlocalizedEvidence.length).toBeGreaterThan(0);
      expect(record.unlocalizedEvidence[0]!.reason).toContain("截断");
    });
  });

  it("provider 失败（HTTP 402）保存 failed 记录；结果未知（超时）保存 outcome_unknown 记录；grade 均不变", async () => {
    const fx = await buildDecisionFixture();
    await withServer((_req, res) => { res.statusCode = 402; res.end(JSON.stringify({ detail: "Balance is not enough" })); }, async (endpoint) => {
      const record = await assist(fx, antProfileFor(endpoint), clientFor(antProfileFor(endpoint)));
      expect(record.status).toBe("failed");
      expect(record.error).toMatchObject({ code: "insufficient_balance", outcomeUnknown: false, httpStatus: 402 });
      expect(existsSync(join(fx.trialDir, "decision-review.json"))).toBe(true);
    });
    const fx2 = await buildDecisionFixture();
    await withServer(() => { /* 永远不应答 */ }, async (endpoint) => {
      const record = await assist(fx2, xiangxinProfileFor(endpoint), clientFor(xiangxinProfileFor(endpoint), 150));
      expect(record.status).toBe("outcome_unknown");
      expect(record.error).toMatchObject({ code: "timeout", outcomeUnknown: true });
      const latest = await serviceFor(fx2).getLatest(fx2.runId, fx2.trialId);
      expect(latest?.status).toBe("outcome_unknown");
    });
  });

  it("未完成/无答卷的 trial 拒绝辅助", async () => {
    const fx = await buildDecisionFixture({ executionStatus: "outcome_unknown", finalAnswerSheet: null });
    await withServer((_req, res) => { res.end(JSON.stringify(antBody())); }, async (endpoint) => {
      await expect(assist(fx, antProfileFor(endpoint), clientFor(antProfileFor(endpoint))))
        .rejects.toThrow(/已完成且有有效答卷/);
      expect(existsSync(join(fx.trialDir, "decision-review.json"))).toBe(false);
    });
  });

  it("保存前材料变化（服务端响应途中改写 trial）→ 不保存为可消费结果", async () => {
    const fx = await buildDecisionFixture();
    await withServer((_req, res) => {
      fx.rewriteTrial({ finalAnswerSheet: FIXTURE_ANSWER + "（被改动）" });
      res.end(JSON.stringify(antBody()));
    }, async (endpoint) => {
      await expect(assist(fx, antProfileFor(endpoint), clientFor(antProfileFor(endpoint))))
        .rejects.toThrow(/已变化，结果未保存/);
      expect(existsSync(join(fx.trialDir, "decision-review.json"))).toBe(false);
      expect(existsSync(join(fx.trialDir, "decision-reviews.jsonl"))).toBe(false);
    });
  });

  it("绝不修改 grade 与 trial：成功后原文件字节不变", async () => {
    const fx = await buildDecisionFixture();
    const trialBefore = readFileSync(join(fx.trialDir, "trial.json"), "utf8");
    await withServer((_req, res) => { res.end(JSON.stringify(antBody())); }, async (endpoint) => {
      await assist(fx, antProfileFor(endpoint), clientFor(antProfileFor(endpoint)));
      expect(readFileSync(join(fx.trialDir, "trial.json"), "utf8")).toBe(trialBefore);
    });
  });
});
