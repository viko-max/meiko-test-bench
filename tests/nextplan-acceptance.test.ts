import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { ImportService } from "../src/import/import-service.js";
import { importDataset } from "../src/dataset/import.js";
import { runBatch } from "../src/runner/batch.js";
import { EXAM_TOOLS_VERSION } from "../src/tools/index.js";
import { TaskControlService } from "../src/service/task-service.js";
import { ReviewService } from "../src/service/review-service.js";
import type { Registry } from "../src/providers/pi-adapter.js";

let root: string;

// Mixed dataset (Next_Plan §7 acceptance): single_choice (scored), numeric_unit
// (scored), single_choice answered uncertainly (-> pending, reviewable), and a
// multi_blank with NO scoring basis (-> ungraded, shown-not-counted).
const MIXED = {
  questions: [
    { id: "c1", subject: "math", answer_kind: "single_choice", question: "2+2=?", options: { A: "3", B: "4" }, answer: "B", maxScore: 5 },
    { id: "n1", subject: "physics", answer_kind: "numeric_unit", question: "求力 F (m=2,a=3)", answer: "6", units: ["N"], maxScore: 10 },
    { id: "o1", subject: "chem", answer_kind: "single_choice", question: "Which catalyst?", options: { A: "X", B: "Y", C: "Z" }, answer: "C", maxScore: 4 },
    { id: "m1", subject: "bio", answer_kind: "multi_blank", question: "Fill: organelle __ makes ATP" },
  ],
};

// Serial order = importDataset's sorted filenames: c1, m1, n1, o1 (per mode).
const RESPONSES = [
  "The answer is B.", // c1 -> correct
  " mitochondria ", // m1 -> ungraded (no scoring basis)
  "F = 6 N", // n1 -> correct
  "I'm not certain, but possibly C", // o1 -> uncertainty -> pending
  "The answer is B.", " mitochondria ", "F = 6 N", "I'm not certain, but possibly C", // with_tool
];

function makeRegistry(): { registry: Registry; callCount: () => number } {
  const faux = fauxProvider();
  faux.setResponses(RESPONSES.map((r) => fauxAssistantMessage(r)));
  const models = createModels();
  models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({
    id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "F1", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { text: "verified", imageInput: "verified", toolCalling: "verified", imageToolResult: "verified", usage: "verified", verificationEvidence: "t" },
  });
  return { registry: { models, profilesById: new Map([["faux", profile]]) }, callCount: () => faux.state.callCount };
}

async function setupMixed(): Promise<{ datasetsRoot: string; datasetDir: string; runsRoot: string; workRoot: string }> {
  mkdirSync(resolve(".work"), { recursive: true });
  root = mkdtempSync(resolve(".work", "nextplan-acceptance-"));
  const datasetsRoot = join(root, "datasets");
  mkdirSync(datasetsRoot, { recursive: true });
  const srcDir = join(root, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "mixed.json"), JSON.stringify(MIXED), "utf8");
  const importer = new ImportService(datasetsRoot, join(root, ".import"));
  const draft = importer.importSource(srcDir, { datasetId: "mixed" });
  await importer.confirmDraft(draft.draftId);
  return { datasetsRoot, datasetDir: join(datasetsRoot, "mixed"), runsRoot: join(root, "runs"), workRoot: join(root, "work") };
}

describe("Next_Plan §5/§7 offline acceptance: import -> two modes -> resume -> report -> review", () => {
  it("confirmed mixed dataset reads back with mixed answer kinds + isolated scoring", async () => {
    const { datasetDir } = await setupMixed();
    const imported = await importDataset({ datasetId: "mixed", publicDir: join(datasetDir, "public"), scoringDir: join(datasetDir, "scoring") });
    const kinds = imported.entries.filter((e) => e.question).map((e) => e.question!.answerKind).sort();
    expect(kinds).toEqual(["multi_blank", "numeric_unit", "single_choice", "single_choice"]);
    // scoring isolated: scored questions have a spec; the unscored multi_blank does not
    expect(imported.entries.find((e) => e.questionId === "c1")?.scoring?.maxScore).toBe(5);
    expect(imported.entries.find((e) => e.questionId === "m1")?.scoring).toBeUndefined();
  });

  it("both modes run from the imported set; resume adds NO model requests; report keeps pending/ungraded visible", async () => {
    const { datasetDir, runsRoot, workRoot } = await setupMixed();
    const base = { datasetId: "mixed", datasetDir, modes: ["without_tool", "with_tool"] as Array<"without_tool" | "with_tool">, profileId: "faux", modelId: "faux-1", limit: 10, runsRoot, workRoot, toolsVersion: EXAM_TOOLS_VERSION, pythonInterpreter: "python", modelsConfigPath: "(unused)", concurrency: 1 };

    const r1registry = makeRegistry();
    const r1 = await runBatch({ ...base, registryOverride: r1registry.registry });
    expect(r1registry.callCount()).toBe(8); // 4 questions x 2 modes, serial

    const wt = r1.byMode.without_tool!;
    expect(wt.report.totals.confirmedRaw).toBe(15); // c1(5) + n1(10); o1 pending, m1 ungraded
    // unknown/needs-review results are NOT dropped from the report
    const ids = wt.report.perQuestion.map((r) => r.questionId).sort();
    expect(ids).toEqual(["c1", "m1", "n1", "o1"]);
    expect(wt.report.coverage["grade:pending_human_review"]).toBeGreaterThanOrEqual(1); // o1
    expect(wt.report.totals.plannedMax).toBe(19); // 5 + 10 + 4 (m1 unscored, not counted)

    // resume: same identity -> everything loaded from archive, ZERO new requests
    const r2registry = makeRegistry();
    const r2 = await runBatch({ ...base, resume: true, registryOverride: r2registry.registry });
    expect(r2registry.callCount()).toBe(0);
    expect(r2.byMode.without_tool!.report.totals.confirmedRaw).toBe(15); // unchanged
  });

  it("a pending answer can be human-reviewed and then counts toward the score", async () => {
    const { datasetDir, runsRoot, workRoot } = await setupMixed();
    const base = { datasetId: "mixed", datasetDir, modes: ["without_tool"] as Array<"without_tool" | "with_tool">, profileId: "faux", modelId: "faux-1", limit: 10, runsRoot, workRoot, toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "(unused)", concurrency: 1 };
    const reg = makeRegistry();
    const r1 = await runBatch({ ...base, registryOverride: reg.registry });
    const runId = r1.byMode.without_tool!.runId;

    const rev = new ReviewService(runsRoot, datasetDir, "mixed");
    const queue = await rev.getQueue(runId, "without_tool");
    const o1 = queue.find((q) => q.questionId === "o1");
    expect(o1, "the uncertain single_choice must be reviewable").toBeTruthy();
    // the unscored multi_blank is NOT reviewable (no scoring basis) and stays visible-but-not-counted
    expect(queue.find((q) => q.questionId === "m1")).toBeUndefined();

    await rev.submitHuman(runId, o1!.trialId, { score: 4, reason: "model's tentative C matches reference", confirmer: "acceptance" }, "without_tool");
    const report = await new TaskControlService().rebuildReport(runsRoot, runId, datasetDir, "mixed", "without_tool");
    expect(report.totals.confirmedRaw).toBe(19); // 15 + o1 human-confirmed 4
    expect(report.coverage["grade:human_confirmed"]).toBeGreaterThanOrEqual(1);
  });
});
