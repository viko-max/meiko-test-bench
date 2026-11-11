import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { ModelProfileSchema, type AnswerMode } from "../src/shared/contracts.js";
import { runBatch, type BatchParams } from "../src/runner/batch.js";
import type { Registry } from "../src/providers/pi-adapter.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

function scriptedRegistry(): { registry: Registry; setResponses: (r: string[]) => void; callCount: () => number } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({
    id: "faux",
    displayName: "Faux",
    provider: "faux",
    api: "faux",
    baseUrl: "http://localhost/",
    auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "Faux 1", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { text: "verified", imageInput: "verified", toolCalling: "verified", imageToolResult: "verified", usage: "verified", verificationEvidence: "test" },
  });
  return {
    registry: { models, profilesById: new Map([["faux", profile]]) },
    setResponses: (r: string[]) => faux.setResponses(r.map((x) => fauxAssistantMessage(x))),
    callCount: () => faux.state.callCount,
  };
}

describe("R3-1 batch concurrency: parallel execution keeps archives/report correct", () => {
  it("concurrency=3 answers each question once, archives Trial+Grade, report is correct", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-conc-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });
    for (const qid of ["q1", "q2", "q3"]) {
      writeFileSync(join(publicDir, `${qid}.md`), `---\nid: ${qid}\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F for m=2,a=3.\n`);
      writeFileSync(join(scoringDir, `${qid}.json`), JSON.stringify({ questionId: qid, questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));
    }

    const s = scriptedRegistry();
    s.setResponses(["F = 6 N", "F = 6 N", "F = 6 N"]); // one per question; identical so order is irrelevant

    const base: Omit<BatchParams, "limit" | "resume" | "concurrency" | "onProgress"> = {
      datasetId: "demo",
      datasetDir: root,
      modes: ["without_tool" as AnswerMode],
      profileId: "faux",
      modelId: "faux-1",
      runsRoot: join(root, "runs"),
      workRoot: join(root, "work"),
      toolsVersion: "v1",
      pythonInterpreter: "python",
      modelsConfigPath: "(unused: registryOverride)",
      registryOverride: s.registry,
    };

    const r = await runBatch({ ...base, limit: 3, resume: false, concurrency: 3, onProgress: () => {} });

    // Exactly one request per question — concurrency never duplicates a request.
    expect(s.callCount()).toBe(3);
    const rep = r.byMode["without_tool"]!.report;
    expect(rep.totals.confirmedRaw).toBe(30); // 3 x 10
    expect(rep.totals.confirmedMax).toBe(30);
    expect(rep.perQuestion).toHaveLength(3);
    expect(new Set(rep.perQuestion.map((x) => x.questionId))).toEqual(new Set(["q1", "q2", "q3"]));

    // Every question archived its own Trial + Grade.
    const runsRoot = join(root, "runs");
    const runDir = readdirSync(runsRoot).find((d) => existsSync(join(runsRoot, d, "trials")))!;
    const trialDirs = readdirSync(join(runsRoot, runDir, "trials"));
    expect(trialDirs).toHaveLength(3);
    for (const t of trialDirs) {
      expect(existsSync(join(runsRoot, runDir, "trials", t, "trial.json"))).toBe(true);
      expect(existsSync(join(runsRoot, runDir, "trials", t, "grade.json"))).toBe(true);
    }
  });
});
