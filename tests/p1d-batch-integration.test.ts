import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { ModelProfileSchema, type AnswerMode } from "../src/shared/contracts.js";
import { runBatch, type BatchParams } from "../src/runner/batch.js";
import type { Registry } from "../src/providers/pi-adapter.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

function scriptedRegistry(): { registry: Registry; setResponses: (r: string[]) => void } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({
    id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "Faux 1", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { text: "verified", imageInput: "verified", toolCalling: "verified", imageToolResult: "verified", usage: "verified", verificationEvidence: "t" },
  });
  return { registry: { models, profilesById: new Map([["faux", profile]]) }, setResponses: (r: string[]) => faux.setResponses(r.map((x) => fauxAssistantMessage(x))) };
}

describe("P1-D batch runs through the per-request scheduler (agent-compatible)", () => {
  it("completes with requestSchedulerLimits set (wrapper does not break the agent)", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-p1d-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    for (const qid of ["q1", "q2"]) {
      writeFileSync(join(publicDir, `${qid}.md`), `---\nid: ${qid}\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F.\n`);
      writeFileSync(join(scoringDir, `${qid}.json`), JSON.stringify({ questionId: qid, questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));
    }
    const s = scriptedRegistry();
    s.setResponses(["F = 6 N", "F = 6 N"]);
    const base: Omit<BatchParams, "limit" | "resume" | "concurrency" | "requestSchedulerLimits" | "onProgress"> = {
      datasetId: "demo", datasetDir: root, modes: ["without_tool" as AnswerMode], profileId: "faux", modelId: "faux-1",
      runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "x", registryOverride: s.registry,
    };
    const r = await runBatch({ ...base, limit: 2, resume: false, concurrency: 2, requestSchedulerLimits: { maxConcurrent: 1, minIntervalMs: 5 }, onProgress: () => {} });
    expect(r.byMode["without_tool"]!.report.totals.confirmedRaw).toBe(20); // both graded correct -> agent worked through the gate
  });
});
