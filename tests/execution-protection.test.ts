import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelProfileSchema, ProtectionLimitsSchema, PublicQuestionSchema } from "../src/shared/contracts.js";
import { acquireExecutionLease, assertExecutionLease, withExecutionLease, type ExecutionLease } from "../src/runner/execution-lock.js";
import { runBatch, type BatchParams } from "../src/runner/batch.js";
import { runOneTrial } from "../src/runner/trial-service.js";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { probeModel } from "../src/providers/probe.js";

function setup() {
  const base = resolve(".work");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "execution-verification-"));
  mkdirSync(join(root, "public"));
  mkdirSync(join(root, "scoring"));
  for (const id of ["q1", "q2"]) {
    writeFileSync(join(root, "public", `${id}.md`), `---\nid: ${id}\nversion: "1"\nsubject: math\nanswer_kind: single_choice\n---\n\n2+2=?\n\n- A. 3\n- B. 4\n`);
    writeFileSync(join(root, "scoring", `${id}.json`), JSON.stringify({ questionId: id, questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true }));
  }
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("答案是 B"), fauxAssistantMessage("答案是 B")]);
  const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }], capability: { imageInput: "verified" } });
  const params: BatchParams = {
    datasetId: "demo", datasetDir: root, modes: ["without_tool"], profileId: "faux", modelId: "faux-1", limit: 2,
    runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "unused", concurrency: 2,
    registryOverride: { models, profilesById: new Map([["faux", profile]]) },
  };
  const question = PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "math", answerKind: "single_choice", stem: "2+2=? A.3 B.4", assets: [] });
  const trialParams = {
    runSpec: { datasetId: "demo", datasetVersion: "1", questionId: "q1", questionVersion: "1", provider: "faux", modelId: "faux-1", mode: "without_tool" as const, promptVersion: "v1", toolsVersion: "v1", limits: ProtectionLimitsSchema.parse({}) },
    question, index: 0, streamFn: makeExamStreamFn(models), model: faux.getModel(), tools: [], toolsVersion: "v1", runsRoot: params.runsRoot, workRoot: params.workRoot,
  };
  return { params, trialParams, faux, models };
}

function child(built = false) {
  const proc = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/execution-child.ts", ...(built ? ["--built"] : [])], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  proc.stderr!.on("data", (data) => { stderr += data.toString(); });
  const exited = once(proc, "exit");
  const ready = new Promise<{ status: string; message?: string }>((resolveReady, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`child startup timed out: ${stderr}`)); }, 10000);
    proc.once("message", (message) => { clearTimeout(timer); resolveReady(message as { status: string; message?: string }); });
    proc.once("error", (error) => { clearTimeout(timer); reject(error); });
    proc.once("exit", () => { clearTimeout(timer); reject(new Error(`child exited before reporting: ${stderr}`)); });
  });
  return { proc, ready, exited };
}

async function stop(proc: ChildProcess, exited: Promise<unknown>): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  await exited;
}

describe("项目执行互斥", () => {
  it("源码和构建产物的独立进程使用同一个锁", async () => {
    const first = child();
    let second: ReturnType<typeof child> | undefined;
    try {
      expect((await first.ready).status).toBe("acquired");
      second = child(true);
      expect((await second.ready).status).toBe("refused");
    } finally {
      await stop(first.proc, first.exited);
      if (second) await stop(second.proc, second.exited);
    }
  }, 20000);

  it.each([false, true])("两个独立进程争用，持有者退出后释放，强制终止=%s", async (force) => {
    const first = child();
    let second: ReturnType<typeof child> | undefined;
    try {
      expect((await first.ready).status).toBe("acquired");
      second = child();
      const rejected = await second.ready;
      expect(rejected.status).toBe("refused");
      expect(rejected.message).toContain("No request was sent");
      await second.exited;
      if (force) first.proc.kill();
      else first.proc.send("release");
      await first.exited;
      await withExecutionLease(async (lease) => assertExecutionLease(lease));
    } finally {
      await stop(first.proc, first.exited);
      if (second) await stop(second.proc, second.exited);
    }
  }, 20000);

  it("其他进程持锁时批量、单题、探测都不发送请求或写入存档", async () => {
    const owner = child();
    const s = setup();
    try {
      expect((await owner.ready).status).toBe("acquired");
      await expect(runBatch({ ...s.params, resume: true })).rejects.toThrow("execution refused");
      await expect(runOneTrial(s.trialParams)).rejects.toThrow("execution refused");
      await expect(probeModel(s.models, s.trialParams.model, { prompt: "pong" })).rejects.toThrow("execution refused");
      expect(s.faux.state.callCount).toBe(0);
      expect(existsSync(s.params.runsRoot)).toBe(false);
      expect(existsSync(s.params.workRoot)).toBe(false);
    } finally {
      await stop(owner.proc, owner.exited);
    }
  }, 20000);

  it("伪造或释放后的执行权不能绕过单题保护", async () => {
    const s = setup();
    const forged: ExecutionLease = { port: 1, release: async () => {} };
    await expect(runOneTrial({ ...s.trialParams, executionLease: forged })).rejects.toThrow("Invalid or released");
    const lease = await acquireExecutionLease();
    await lease.release();
    await lease.release();
    await expect(runOneTrial({ ...s.trialParams, executionLease: lease })).rejects.toThrow("Invalid or released");
    expect(s.faux.state.callCount).toBe(0);
  });

  it("异常退出服务函数释放执行权", async () => {
    const s = setup();
    await expect(runBatch({ ...s.params, modelId: "missing" })).rejects.toThrow("model not found");
    await expect(withExecutionLease(async () => { throw new Error("intentional failure"); })).rejects.toThrow("intentional failure");
    const result = await runOneTrial(s.trialParams);
    expect(result.trial.executionStatus).toBe("completed");
    expect(s.faux.state.callCount).toBe(1);
  });

  it("批量内部并发仍可用，运行中拒绝第二批，结束后续跑不重答", async () => {
    const s = setup();
    let signalRunning!: () => void;
    const running = new Promise<void>((resolveRunning) => { signalRunning = resolveRunning; });
    let unblock!: () => void;
    const gate = new Promise<void>((resolveGate) => { unblock = resolveGate; });
    const importModule = await import("../src/dataset/import.js");
    // 保持真实 Pi 作答和存档流程，通过导入阶段的可控边界确认锁覆盖续跑之前。
    const { vi } = await import("vitest");
    const original = importModule.importDataset;
    const spy = vi.spyOn(importModule, "importDataset").mockImplementation(async (p) => {
      signalRunning();
      await gate;
      return original(p);
    });
    let inFlight = 0;
    let peak = 0;
    const task = runBatch({ ...s.params, onEvent: (event) => {
      if (event.type === "question_running") peak = Math.max(peak, ++inFlight);
      if (event.type === "question_done") inFlight--;
    } });
    try {
      await running;
      await expect(runBatch({ ...s.params, resume: true })).rejects.toThrow("execution refused");
      unblock();
      const result = await task;
      expect(s.faux.state.callCount).toBe(2);
      expect(peak).toBe(2);
      expect(result.byMode.without_tool!.report.totals.confirmedRaw).toBe(10);
    } finally {
      unblock();
      await task;
      spy.mockRestore();
    }
    const resumed = await runBatch({ ...s.params, resume: true });
    expect(s.faux.state.callCount).toBe(2);
    expect(resumed.byMode.without_tool!.report.totals.confirmedRaw).toBe(10);
  });

  it("停止后释放执行权，续跑只执行未开始的题目", async () => {
    const s = setup();
    const controller = new AbortController();
    await runBatch({ ...s.params, concurrency: 1, signal: controller.signal, onEvent: (event) => {
      if (event.type === "question_done") controller.abort();
    } });
    expect(s.faux.state.callCount).toBe(1);
    const result = await runBatch({ ...s.params, resume: true });
    expect(s.faux.state.callCount).toBe(2);
    expect(result.byMode.without_tool!.report.totals.confirmedRaw).toBe(10);
  });

  it("正常能力探测结束后可以启动测评", async () => {
    const s = setup();
    expect((await probeModel(s.models, s.trialParams.model, { prompt: "pong" })).ok).toBe(true);
    await withExecutionLease(async (lease) => assertExecutionLease(lease));
    expect(s.faux.state.callCount).toBe(1);
  });
});
