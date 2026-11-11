/** Batch exam runner entry. PAID/network — requires --authorise-paid. */
import type { AnswerMode } from "../src/shared/contracts.js";
import { runBatch } from "../src/runner/batch.js";

function arg(name: string, d?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : d;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--authorise-paid")) {
    console.error("REFUSED: batch run places real (paid) model calls. Add --authorise-paid with an explicit --limit/--modes.");
    process.exit(2);
  }
  const datasetId = arg("--dataset", "demo")!;
  const profileId = arg("--profile", "longcat")!;
  const modelId = arg("--model", "LongCat-2.5-Preview")!;
  const limit = Number(arg("--limit", "40"));
  const modesArg = arg("--modes", "both")!;
  const modes: AnswerMode[] = modesArg === "both" ? ["without_tool", "with_tool"] : (modesArg.split(",") as AnswerMode[]);

  const result = await runBatch({
    datasetId,
    datasetVersion: arg("--dataset-version", "1"),
    datasetDir: `datasets/${datasetId}`,
    modes,
    profileId,
    modelId,
    limit,
    runsRoot: "runs",
    workRoot: ".work",
    toolsVersion: "v1",
    pythonInterpreter: "pyenv/.venv/Scripts/python.exe",
    modelsConfigPath: "configs/models.json",
    limitsPath: "configs/limits.json",
    resume: process.argv.includes("--resume"), // dedup against archives is now the DEFAULT; --resume kept for compatibility
    fresh: process.argv.includes("--fresh"), // P1-1: explicitly ignore existing answers and re-bill (loud warning)
    runId: arg("--run-id"), // explicit Run to resume (P1-3)
    requestSchedulerLimits: process.argv.includes("--request-scheduler")
      ? { maxConcurrent: Number(arg("--max-concurrent-requests", "2")), minIntervalMs: Number(arg("--min-request-interval-ms", "0")) }
      : undefined,
    concurrency: Math.max(1, Number(arg("--concurrency", "1"))), // default 1 = serial (unchanged)
    requestTimeoutMs: Number(arg("--request-timeout-ms", "120000")),
    onProgress: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  });

  for (const [mode, r] of Object.entries(result.byMode)) {
    const t = r!.report.totals;
    console.log(`MODE ${mode}: confirmed ${t.confirmedRaw}/${t.confirmedMax} (plannedMax ${t.plannedMax}) -> ${r!.reportMdPath}`);
  }
  console.log(`BATCH_DONE questions=${result.questionCount} plannedMax=${result.plannedMax}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
