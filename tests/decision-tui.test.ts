import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExamApp } from "../src/tui/app.js";
import { ExamTui } from "../src/tui/controller.js";
import { prepareMascotImage } from "../src/tui/mascot.js";
import { buildDecisionFixture, FIXTURE_ANSWER } from "./helpers/decision.js";
import { SystemOneClient } from "../src/providers/systemone.js";
import type { DecisionProviderProfile } from "../src/shared/decision.js";
import { ANT_DECISION_PROFILE, XIANGXIN_DECISION_PROFILE } from "../src/shared/decision.js";

beforeAll(async () => prepareMascotImage());
afterEach(() => vi.restoreAllMocks());

async function withServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void, fn: (endpoint: string, captured: { count: number }) => Promise<void>): Promise<void> {
  const captured = { count: 0 };
  const server: Server = createServer((_req, res) => {
    captured.count += 1;
    void handler(_req, res);
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

function antOkBody() {
  const start = FIXTURE_ANSWER.indexOf("最终选择");
  const text = "最终选择 A 和 J";
  return {
    errorCode: 0, model: "lingdt-decision-1.0",
    usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120 },
    answers: {
      conclusion_kind: { choice: "explicit_multiple", probabilities: { explicit_single: 0.1, explicit_multiple: 0.8, no_conclusion: 0.05, insufficient_evidence: 0.05 }, confidence: 0.9 },
      has_explicit_conclusion: { noul: 0.95 },
      selected_options: {
        choices: ["A", "J"],
        probabilities: { A: 0.9, B: 0.01, C: 0.01, D: 0.01, E: 0.01, F: 0.01, G: 0.01, H: 0.01, I: 0.01, J: 0.85 },
        confidence: 0.88,
      },
      answer_evidence: { spans: [{ type: "evidence", text, start, end: start + text.length, confidence: 0.9 }], model_span_count: 1, truncated: false },
    },
  };
}

async function tuiFor(fx: Awaited<ReturnType<typeof buildDecisionFixture>>, endpoint: string, timeoutMs = 5_000) {
  const modelsConfigPath = join(fx.root, "models.json");
  writeFileSync(modelsConfigPath, JSON.stringify({ version: "1", profiles: [] }));
  const tui = new ExamTui({
    datasetsRoot: fx.datasetsRoot, modelsConfigPath,
    runsRoot: fx.runsRoot, workRoot: join(fx.root, "work"),
    toolsVersion: "v1", pythonInterpreter: "python",
    decisionClientFactory: (profile: DecisionProviderProfile) => {
      const baseUrl = profile.id === "ant-decision" ? endpoint : endpoint; // 本机测试服务按 profile 信封分支
      return new SystemOneClient({ ...profile, baseUrl }, { fetch: globalThis.fetch, getApiKey: () => "test-key-value", timeoutMs });
    },
  });
  const app = new ExamApp(tui);
  app.rerender = vi.fn();
  await tui.openReview(fx.runId);
  expect(tui.getState().screen.kind).toBe("review");
  return { tui, app };
}

const flush = () => new Promise<void>((done) => setImmediate(done));

describe("TUI /review 决策辅助：configs/decision.json 本地配置", () => {
  const writeDecisionConfig = (fx: Awaited<ReturnType<typeof buildDecisionFixture>>, content: unknown) => {
    writeFileSync(join(fx.root, "decision.json"), typeof content === "string" ? content : JSON.stringify(content));
  };

  it("本地 decision.json 可切换模型 id / 凭据环境变量名 / 能力；$comment 文档键被剥离", async () => {
    const fx = await buildDecisionFixture();
    writeDecisionConfig(fx, {
      $comment: "文档键：解析前必须剥离，否则 strict 解析失败。",
      profiles: [
        {
          id: "custom-decision",
          displayName: "本地自定义决策",
          baseUrl: "https://example.invalid/v1/systemone",
          apiKeyEnv: "CUSTOM_DECISION_KEY",
          model: "custom-decision-x",
          envelope: "standard",
          capabilities: ["choice", "noul"],
          enabled: true,
        },
      ],
    });
    const modelsConfigPath = join(fx.root, "models.json");
    writeFileSync(modelsConfigPath, JSON.stringify({ version: "1", profiles: [] }));
    const seen: Array<{ auth: string | undefined; body: { model?: string } }> = [];
    await withServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        res.end(JSON.stringify({
          model: "custom-decision-x-actual",
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          answers: {
            conclusion_kind: { choice: "explicit_single", probabilities: { explicit_single: 0.9, explicit_multiple: 0.05, no_conclusion: 0.03, insufficient_evidence: 0.02 }, confidence: 0.9 },
            has_explicit_conclusion: { noul: 0.9 },
          },
        }));
      });
    }, async (endpoint) => {
      process.env.CUSTOM_DECISION_KEY = "custom-key-value";
      try {
        const tui = new ExamTui({
          datasetsRoot: fx.datasetsRoot, modelsConfigPath,
          runsRoot: fx.runsRoot, workRoot: join(fx.root, "work"),
          toolsVersion: "v1", pythonInterpreter: "python",
          decisionClientFactory: (profile: DecisionProviderProfile) =>
            new SystemOneClient({ ...profile, baseUrl: endpoint }, { fetch: globalThis.fetch, timeoutMs: 5_000 }),
        });
        const profiles = tui.decisionProfiles();
        expect(profiles.map((p) => p.id)).toEqual(["custom-decision"]);
        expect(profiles[0]).toMatchObject({ model: "custom-decision-x", apiKeyEnv: "CUSTOM_DECISION_KEY", capabilities: ["choice", "noul"] });
        await tui.openReview(fx.runId);
        await tui.startDecisionAssist();
        const record = tui.getDecisionState()?.record;
        expect(record?.status).toBe("completed");
        expect(record?.requestedModel).toBe("custom-decision-x");
        expect(record?.actualModel).toBe("custom-decision-x-actual");
        // 能力只剩 choice/noul：缺失能力显式列 limitations，绝不静默降级。
        expect(record?.limitations.join("\n")).toContain("multi-choice");
        expect(record?.limitations.join("\n")).toContain("span");
        expect(record?.selectedOptions).toEqual([]); // 无证据能力，不从证据推导
        expect(seen).toHaveLength(1);
        expect(seen[0]!.body.model).toBe("custom-decision-x"); // 请求体使用本地配置的模型 id
        expect(seen[0]!.auth).toBe("Bearer custom-key-value"); // Bearer 来自本地配置指定的环境变量名
      } finally {
        delete process.env.CUSTOM_DECISION_KEY;
      }
    });
  });

  it("decision.json 损坏（非法 JSON / schema 违规 / 含凭据形态值）直接报错，绝不静默默认、不发起请求", async () => {
    const secretValue = "sk-abcdefghijklmnop12345678";
    for (const bad of [
      '{ "profiles": [',
      { profiles: [{ id: "x", apiKeyEnv: "MY_KEY", model: "m", envelope: "standard", capabilities: ["choice"], enabled: true }] },
      { profiles: [{ id: "x", displayName: "x", baseUrl: "https://example.invalid/v1/systemone", apiKeyEnv: "MY_KEY", model: "m", envelope: "standard", capabilities: ["choice"], enabled: true, extra: 1 }] },
      { profiles: [{ id: "x", displayName: "x", baseUrl: "https://example.invalid/v1/systemone", apiKeyEnv: "MY_KEY", model: "m", envelope: "standard", capabilities: ["choice"], enabled: true, notes: `leaked ${secretValue}` }] },
    ]) {
      const fx = await buildDecisionFixture();
      writeDecisionConfig(fx, bad);
      const modelsConfigPath = join(fx.root, "models.json");
      writeFileSync(modelsConfigPath, JSON.stringify({ version: "1", profiles: [] }));
      await withServer(() => { /* 不应被调用 */ }, async (endpoint, captured) => {
        const tui = new ExamTui({
          datasetsRoot: fx.datasetsRoot, modelsConfigPath,
          runsRoot: fx.runsRoot, workRoot: join(fx.root, "work"),
          toolsVersion: "v1", pythonInterpreter: "python",
          decisionClientFactory: () => new SystemOneClient(ANT_DECISION_PROFILE, { fetch: globalThis.fetch }),
        });
        expect(() => tui.decisionProfiles()).toThrow();
        await tui.openReview(fx.runId);
        await expect(tui.startDecisionAssist()).rejects.toThrow();
        expect(tui.getDecisionState()?.running).toBeUndefined();
        expect(captured.count).toBe(0); // 坏配置绝不发起请求
        expect(existsSync(join(fx.trialDir, "decision-review.json"))).toBe(false);
      });
    }
  });
});

describe("TUI /review 决策辅助（注入离线 client）", () => {
  it("默认决策模型为蚂蚁+象信；无授权且无注入 client 时拒绝真实调用", async () => {
    const fx = await buildDecisionFixture();
    const modelsConfigPath = join(fx.root, "models.json");
    writeFileSync(modelsConfigPath, JSON.stringify({ version: "1", profiles: [] }));
    const tui = new ExamTui({
      datasetsRoot: fx.datasetsRoot, modelsConfigPath,
      runsRoot: fx.runsRoot, workRoot: join(fx.root, "work"),
      toolsVersion: "v1", pythonInterpreter: "python",
    });
    const ids = tui.decisionProfiles().map((p) => p.id);
    expect(ids).toEqual(["ant-decision", "xiangxin-decision"]); // 默认蚂蚁+象信
    await tui.openReview(fx.runId);
    await expect(tui.startDecisionAssist()).rejects.toThrow(/authorise-paid/);
    expect(tui.getDecisionState()?.running).toBeUndefined();
    expect(existsSync(join(fx.trialDir, "decision-review.json"))).toBe(false);
  });

  it("正常入口：d 发起一次辅助复核，展示结果与“仅辅助，需人工确认”，grade 字节不变", async () => {
    const fx = await buildDecisionFixture();
    await withServer((_req, res) => { res.end(JSON.stringify(antOkBody())); }, async (endpoint, captured) => {
      const { tui, app } = await tuiFor(fx, endpoint);
      const gradeBefore = fx.gradeBytes();
      for (const ch of "d") app.handleInput(ch);
      // 等待辅助完成（含一次本机请求往返）
      for (let i = 0; i < 200 && (tui.getDecisionState()?.running ?? true); i++) await flush();
      const state = tui.getDecisionState();
      expect(state?.running).toBe(false);
      expect(state?.record?.status).toBe("completed");
      expect(state?.record?.choice).toBe("explicit_multiple");
      expect(state?.record?.selectedOptions).toEqual(["A", "J"]);
      expect(captured.count).toBe(1); // 每次只发一次请求，无自动重试
      expect(fx.gradeBytes()).toBe(gradeBefore); // grade 文件字节不变
      const output = app.render(100).join("\n");
      expect(output).toContain("决策辅助");
      expect(output).toContain("仅辅助，需人工确认");
      expect(output).toContain("lingdt-decision-1.0"); // 请求/实际模型
      expect(output).toContain("最终选择 A 和 J"); // 原文证据
    });
  });

  it("o 切换决策模型；运行中不可切换", async () => {
    const fx = await buildDecisionFixture();
    await withServer(() => { /* 挂起以保持运行中 */ }, async (endpoint) => {
      const { tui } = await tuiFor(fx, endpoint);
      tui.cycleDecisionProfile();
      expect(tui.getDecisionState()?.profileIndex).toBe(1);
      const pending = tui.startDecisionAssist();
      await flush();
      expect(tui.hasPendingDecisionAssist()).toBe(true);
      tui.cycleDecisionProfile(); // 运行中切换被拒
      expect(tui.getState().message).toContain("进行中");
      await tui.stopAndWait(); // 停止：取消并等待存档
      await pending.catch(() => undefined);
      expect(tui.hasPendingDecisionAssist()).toBe(false);
      expect(tui.getDecisionState()?.record?.status).toBe("outcome_unknown");
    });
  });

  it("取消进行中的调用并等待存档：outcome_unknown，服务端只收到一次请求", async () => {
    const fx = await buildDecisionFixture();
    await withServer(() => { /* 永远不应答 */ }, async (endpoint, captured) => {
      const { tui } = await tuiFor(fx, endpoint, 10_000);
      const pending = tui.startDecisionAssist();
      await flush();
      expect(tui.cancelDecisionAssist()).toBe(true);
      await pending.catch(() => undefined);
      await flush();
      const record = tui.getDecisionState()?.record;
      expect(record?.status).toBe("outcome_unknown");
      expect(record?.error?.code).toBe("cancelled");
      expect(record?.error?.outcomeUnknown).toBe(true);
      expect(existsSync(join(fx.trialDir, "decision-review.json"))).toBe(true); // 未知结果也存档
      expect(captured.count).toBe(1);
    });
  });

  it("402 预算不足：failed 记录保存，界面提示确定结果；grade 不变", async () => {
    const fx = await buildDecisionFixture();
    await withServer((_req, res) => { res.statusCode = 402; res.end(JSON.stringify({ detail: "Balance is not enough" })); }, async (endpoint, captured) => {
      const { tui, app } = await tuiFor(fx, endpoint);
      const gradeBefore = fx.gradeBytes();
      await tui.startDecisionAssist();
      const record = tui.getDecisionState()?.record;
      expect(record?.status).toBe("failed");
      expect(record?.error).toMatchObject({ code: "insufficient_balance", outcomeUnknown: false, httpStatus: 402 });
      expect(tui.getState().message).toContain("失败");
      expect(fx.gradeBytes()).toBe(gradeBefore);
      expect(captured.count).toBe(1);
      expect(app.render(100).join("\n")).toContain("insufficient_balance");
    });
  });

  it("超时与 invalid response：outcome_unknown 存档，无自动重试", async () => {
    const fx = await buildDecisionFixture();
    await withServer(() => { /* 挂起 → 客户端超时 */ }, async (endpoint, captured) => {
      const { tui } = await tuiFor(fx, endpoint, 150);
      await tui.startDecisionAssist();
      expect(tui.getDecisionState()?.record).toMatchObject({ status: "outcome_unknown", error: { code: "timeout", outcomeUnknown: true } });
      expect(captured.count).toBe(1);
    });
    const fx2 = await buildDecisionFixture();
    await withServer((_req, res) => { res.end("<<not-json>>"); }, async (endpoint, captured) => {
      const { tui } = await tuiFor(fx2, endpoint);
      await tui.startDecisionAssist();
      expect(tui.getDecisionState()?.record).toMatchObject({ status: "outcome_unknown", error: { code: "invalid_json", outcomeUnknown: true } });
      expect(existsSync(join(fx2.trialDir, "decision-review.json"))).toBe(true);
      expect(captured.count).toBe(1);
    });
  });

  it("象信 profile：span 证据按码点换算 UTF16 展示，actual model 来自响应", async () => {
    const fx = await buildDecisionFixture();
    const codepoints = Array.from(FIXTURE_ANSWER);
    const startCp = Array.from(FIXTURE_ANSWER.slice(0, FIXTURE_ANSWER.indexOf("故选"))).length;
    const text = "故选 A、J";
    await withServer((_req, res) => {
      res.end(JSON.stringify({
        model: "xiangxin-3.8-actual",
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        answers: {
          conclusion_kind: { choice: "explicit_multiple", probabilities: { explicit_single: 0.1, explicit_multiple: 0.85, no_conclusion: 0.03, insufficient_evidence: 0.02 }, confidence: 0.88 },
          has_explicit_conclusion: { noul: 0.92 },
          answer_evidence_span: { spans: [{ path: "", start: startCp, end: startCp + Array.from(text).length, text, confidence: 0.86 }] },
        },
      }));
    }, async (endpoint) => {
      const { tui, app } = await tuiFor(fx, endpoint);
      tui.cycleDecisionProfile(); // 切到象信
      expect(tui.decisionProfiles()[tui.getDecisionState()?.profileIndex ?? 0]?.id).toBe("xiangxin-decision");
      await tui.startDecisionAssist();
      const record = tui.getDecisionState()?.record;
      expect(record?.status).toBe("completed");
      expect(record?.actualModel).toBe("xiangxin-3.8-actual");
      expect(record?.evidence[0]).toMatchObject({ quote: "故选 A、J", encoding: "codepoint" });
      const output = app.render(100).join("\n");
      expect(output).toContain("故选 A、J");
      expect(output).toContain("limitations"); // 象信无 multi-choice/extract，显式列出
    });
  });
});
