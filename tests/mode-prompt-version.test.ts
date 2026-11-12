/**
 * Mode-specific prompt/tools identity (v2/v1 without_tool, v3/v2-restricted
 * with_tool). Offline only: faux provider, no network (AGENTS.md §10).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { ModelProfileSchema, PublicQuestionSchema, type AnswerMode, type PublicQuestion } from "../src/shared/contracts.js";
import { buildUserContent } from "../src/runner/prompt.js";
import { PROMPT_VERSION, WITH_TOOL_PROMPT_VERSION, promptVersionForMode } from "../src/runner/prompts.js";
import { runTrial } from "../src/runner/run-trial.js";
import { runOneTrial } from "../src/runner/trial-service.js";
import { runBatch } from "../src/runner/batch.js";
import { EXAM_TOOLS_VERSION, WITHOUT_TOOL_TOOLS_VERSION } from "../src/tools/index.js";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { LimitGuard } from "../src/runner/limits.js";
import { ProtectionLimitsSchema } from "../src/shared/contracts.js";
import { InMemoryTrialRecorder } from "../src/storage/recorder.js";
import { TaskControlService } from "../src/service/task-service.js";
import { readManifest } from "../src/runner/answer-source.js";
import type { Registry } from "../src/providers/pi-adapter.js";
import { setupFaux } from "./helpers/faux.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));
function tmp(prefix: string): string {
  root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

function questionWithAssets(): PublicQuestion {
  return PublicQuestionSchema.parse({
    id: "q1", version: "1", subject: "physics", answerKind: "numeric_unit",
    stem: "根据附件数据求加速度。",
    assets: [
      { ref: "fig/pic.png", mediaType: "image/png", role: "figure" },
      { ref: "data/table.csv", mediaType: "text/csv", role: "data" },
    ],
  });
}

describe("buildUserContent attachment refs", () => {
  it("default output is byte-identical to the original format (no attachment refs)", () => {
    const q = questionWithAssets();
    const content = buildUserContent(q);
    expect(content).toBe(
      [
        "# Question (physics)",
        "",
        "根据附件数据求加速度。",
        "",
        "_This question includes 1 figure(s), provided as image(s) with this message._",
      ].join("\n"),
    );
    expect(content).not.toContain("Public attachments");
    expect(content).not.toContain("table.csv");
  });

  it("includeAssetRefs lists only public relative refs with mediaType", () => {
    const q = questionWithAssets();
    const content = buildUserContent(q, { includeAssetRefs: true });
    expect(content).toContain("## Public attachments");
    expect(content).toContain("- data/table.csv (text/csv)");
    // 图像沿用原图提示，不重复列入；不出现绝对路径或其他字段。
    expect(content).not.toContain("fig/pic.png");
    expect(content).not.toContain(join("public", "data"));
    expect(content).not.toContain("scoring");
    expect(content.indexOf("## Public attachments")).toBeGreaterThan(content.indexOf("figure(s)"));
  });

  it("promptVersionForMode maps modes to v2/v3", () => {
    expect(PROMPT_VERSION).toBe("v2");
    expect(WITH_TOOL_PROMPT_VERSION).toBe("v3");
    expect(promptVersionForMode("without_tool")).toBe("v2");
    expect(promptVersionForMode("with_tool")).toBe("v3");
  });
});

describe("runTrial includeAssetRefs pass-through", () => {
  const userText = (agent: { state: { messages: Array<{ role: string; content: unknown }> } }): string => {
    const user = agent.state.messages.find((m) => m.role === "user");
    const content = user?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text" && typeof (b as { text?: string }).text === "string").map((b) => b.text).join("");
    return "";
  };

  it("with_tool attempt shows public attachment refs; default does not", async () => {
    const q = questionWithAssets();
    const withRefs = setupFaux([fauxAssistantMessage("Answer: 3")], { mode: "with_tool" });
    await runTrial({ agent: withRefs.agent, question: q, guard: withRefs.guard, recorder: withRefs.recorder, includeAssetRefs: true });
    const textWith = userText(withRefs.agent);
    expect(textWith).toContain("## Public attachments");
    expect(textWith).toContain("- data/table.csv (text/csv)");

    const plain = setupFaux([fauxAssistantMessage("Answer: 3")], { mode: "with_tool" });
    await runTrial({ agent: plain.agent, question: q, guard: plain.guard, recorder: plain.recorder });
    expect(userText(plain.agent)).not.toContain("Public attachments");
  });
});

describe("runOneTrial keeps the RunSpec promptVersion", () => {
  it("archives attempt.json / trial.json / run snapshot with the passed version", async () => {
    const dir = tmp("pi-mv-trial-");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Answer: 3")]);
    const question = PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "physics", answerKind: "numeric_unit", stem: "求值。" });
    const res = await runOneTrial({
      runSpec: {
        datasetId: "demo", datasetVersion: "1", questionId: "q1", questionVersion: "1",
        provider: "faux", modelId: faux.getModel().id, mode: "without_tool",
        promptVersion: "v9-custom", toolsVersion: "v1", limits: ProtectionLimitsSchema.parse({}),
      },
      question, index: 0, streamFn: makeExamStreamFn(models), model: faux.getModel(), tools: [], toolsVersion: "v1",
      runsRoot: join(dir, "runs"), workRoot: join(dir, "work"),
    });
    expect(res.trial.promptVersion).toBe("v9-custom"); // 不被全局 PROMPT_VERSION 篡改
    const attempt = JSON.parse(readFileSync(join(dir, "runs", res.runId, "trials", res.trialId, "attempt.json"), "utf8"));
    expect(attempt.promptVersion).toBe("v9-custom");
    const trial = JSON.parse(readFileSync(join(dir, "runs", res.runId, "trials", res.trialId, "trial.json"), "utf8"));
    expect(trial.promptVersion).toBe("v9-custom");
    const snapshot = JSON.parse(readFileSync(join(dir, "runs", res.runId, "run.json"), "utf8"));
    expect(snapshot.promptVersion).toBe("v9-custom");
    rmSync(dir, { recursive: true, force: true });
  });
});

function scriptedRegistry(): { registry: Registry; setResponses: (r: string[]) => void; capturedToolNames: () => string[] } {
  const faux = fauxProvider();
  const models = createModels();
  let tools: string[] = [];
  const capture = (c: unknown): void => {
    const sys = ((c as { messages: Array<{ role?: string; toolsAdded?: Array<{ name: string }> }> }).messages ?? []).find((msg) => msg.role === "system");
    tools = sys?.toolsAdded?.map((t) => t.name) ?? [];
  };
  models.setProvider({
    ...faux.provider,
    stream: (m, c, o) => {
      capture(c);
      return faux.provider.stream(m, c, o);
    },
    streamSimple: (m, c, o) => {
      capture(c);
      return faux.provider.streamSimple(m, c, o);
    },
  });
  const profile = ModelProfileSchema.parse({
    id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "Faux 1", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { text: "verified", imageInput: "verified", toolCalling: "verified", imageToolResult: "verified", usage: "verified", verificationEvidence: "t" },
  });
  return { registry: { models, profilesById: new Map([["faux", profile]]) }, setResponses: (r: string[]) => faux.setResponses(r.map((x) => fauxAssistantMessage(x))), capturedToolNames: () => [...tools] };
}

function makeDataset(): { datasetDir: string; runsRoot: string; workRoot: string } {
  const datasetDir = tmp("pi-mv-ds-");
  const publicDir = join(datasetDir, "public");
  const scoringDir = join(datasetDir, "scoring");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(scoringDir, { recursive: true });
  writeFileSync(join(publicDir, "q1.md"), "---\nid: q1\nversion: \"1\"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F.\n");
  writeFileSync(join(scoringDir, "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));
  return { datasetDir, runsRoot: join(datasetDir, "runs"), workRoot: join(datasetDir, "work") };
}

const batchParams = (ds: ReturnType<typeof makeDataset>, registry: Registry, modes: AnswerMode[], toolsVersion: string) => ({
  datasetId: "demo", datasetDir: ds.datasetDir, modes, profileId: "faux", modelId: "faux-1", limit: 1,
  runsRoot: ds.runsRoot, workRoot: ds.workRoot, toolsVersion, pythonInterpreter: "python", modelsConfigPath: "x", registryOverride: registry,
});

function readTrialJson(runsRoot: string, runId: string): { promptVersion: string; toolsVersion: string; trialId: string } {
  const trialsDir = join(runsRoot, runId, "trials");
  const dir = readdirSync(trialsDir)[0]!;
  return JSON.parse(readFileSync(join(trialsDir, dir, "trial.json"), "utf8"));
}

describe("runBatch mode identity", () => {
  it("without_tool archives prompt=v2/tools=v1 even when the entry passes the current tools version", async () => {
    const ds = makeDataset();
    const s = scriptedRegistry();
    s.setResponses(["F = 6 N"]);
    const result = await runBatch(batchParams(ds, s.registry, ["without_tool"], EXAM_TOOLS_VERSION));
    const runId = result.byMode.without_tool!.runId;
    const manifest = readManifest(ds.runsRoot, runId)!;
    expect(manifest.promptVersion).toBe("v2");
    expect(manifest.toolsVersion).toBe(WITHOUT_TOOL_TOOLS_VERSION); // v1 历史身份，忽略入口值
    const trial = readTrialJson(ds.runsRoot, runId);
    expect(trial.promptVersion).toBe("v2");
    expect(trial.toolsVersion).toBe("v1");
    rmSync(ds.datasetDir, { recursive: true, force: true });
  });

  it("with_tool (current tools) archives prompt=v3/tools=v2-restricted and offers exactly the four exam tools", async () => {
    const ds = makeDataset();
    const s = scriptedRegistry();
    s.setResponses(["F = 6 N"]);
    const result = await runBatch(batchParams(ds, s.registry, ["with_tool"], EXAM_TOOLS_VERSION));
    const runId = result.byMode.with_tool!.runId;
    const manifest = readManifest(ds.runsRoot, runId)!;
    expect(manifest.promptVersion).toBe("v3");
    expect(manifest.toolsVersion).toBe(EXAM_TOOLS_VERSION);
    const trial = readTrialJson(ds.runsRoot, runId);
    expect(trial.promptVersion).toBe("v3");
    expect(trial.toolsVersion).toBe(EXAM_TOOLS_VERSION);
    // 系统提示词只声明四个测评工具，且 without_tool 不带任何工具。
    expect(s.capturedToolNames().sort()).toEqual(["calculate", "process_image", "read_file", "view_image"]);
    rmSync(ds.datasetDir, { recursive: true, force: true });
  });

  it("with_tool with the old v1 tools version is rejected before any provider call", async () => {
    const ds = makeDataset();
    const s = scriptedRegistry();
    // 不注册任何响应：一旦发出 provider 调用，faux 会抛错，测试即失败。
    await expect(runBatch(batchParams(ds, s.registry, ["with_tool"], "v1"))).rejects.toThrow(/with_tool requires the current exam tools version/);
    expect(existsSync(ds.runsRoot)).toBe(false); // 写 manifest 之前就拒绝
    rmSync(ds.datasetDir, { recursive: true, force: true });
  });

  it("TaskControlService.start rejects with_tool+v1 synchronously, before any provider call", () => {
    const ds = makeDataset();
    const s = scriptedRegistry();
    const svc = new TaskControlService();
    expect(() => svc.start(batchParams(ds, s.registry, ["without_tool", "with_tool"], "v1"))).toThrow(/with_tool requires the current exam tools version/);
    expect(existsSync(ds.runsRoot)).toBe(false);
    rmSync(ds.datasetDir, { recursive: true, force: true });
  });

  it("without_tool configDigest/trial identity is unchanged when the entry passes the current tools version", async () => {
    const ds = makeDataset();
    const s = scriptedRegistry();
    s.setResponses(["F = 6 N", "F = 6 N"]);
    const asV1 = await runBatch(batchParams(ds, s.registry, ["without_tool"], "v1"));
    const asCurrent = await runBatch(batchParams(ds, s.registry, ["without_tool"], EXAM_TOOLS_VERSION));
    const svc = new TaskControlService();
    // 第二次启动默认续跑复用旧答卷；有效答卷按来源记录解析到同一 trial。
    const detail = await svc.getValidatedTaskDetail(ds.runsRoot, asCurrent.byMode.without_tool!.runId, ds.datasetDir, "demo", "without_tool");
    expect(detail.questions).toHaveLength(1);
    expect(readTrialJson(ds.runsRoot, asV1.byMode.without_tool!.runId).trialId).toBe(detail.questions[0]!.trialId);
    rmSync(ds.datasetDir, { recursive: true, force: true });
  });
});
