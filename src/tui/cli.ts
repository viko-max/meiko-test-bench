/**
 * Portable interactive CLI (drives the same ExamTui controller as the pi-tui
 * view). Uses readline so it works in ANY terminal — no alt-screen / kitty
 * protocol. Flow: 选题集 -> 检查 -> 选模型与模式 -> 确认 -> 运行/停止 -> 记录/报告.
 * Real (paid) answering requires --authorise-paid (enforced by the controller).
 */
import { createInterface } from "node:readline";
import { ExamTui, type Setup } from "./controller.js";
import type { TaskEvent } from "../runner/task-events.js";

function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, res));
}

function eventLine(e: TaskEvent): string | null {
  switch (e.type) {
    case "question_running":
      return `  ▶ ${e.questionId} (${e.index + 1}/${e.total})${e.withImages ? " +图" : ""}`;
    case "question_done":
      return `  ✔ ${e.questionId} ${e.executionStatus}${e.gradingStatus ? ` · ${e.gradingStatus} ${e.rawScore}/${e.maxScore}` : ""}${e.archiveError ? " · 存档失败" : ""}`;
    case "question_loaded":
      return `  ↺ ${e.questionId} ${e.note}`;
    case "stopped":
      return `  ■ 已停止: ${e.reason}`;
    case "mode_done":
      return `  ■ 模式完成 ${e.confirmedRaw}/${e.confirmedMax}`;
    case "warning":
      return `  ! ${e.message}`;
    case "error":
      return `  ✗ ${e.message}`;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const authorisePaid = process.argv.includes("--authorise-paid");
  const tui = new ExamTui({
    datasetsRoot: "datasets",
    modelsConfigPath: "configs/models.json",
    runsRoot: "runs",
    workRoot: ".work",
    toolsVersion: "v1",
    pythonInterpreter: "pyenv/.venv/Scripts/python.exe",
    limitsPath: "configs/limits.json",
    authorisePaid,
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Meiko Test-Bench · 多学科模型测评");
  const ds = tui.loadDatasets();
  console.log("题集：");
  ds.forEach((d, i) => console.log(`  ${i + 1}. ${d.id}`));
  const pick = (await ask(rl, "选择题集编号: ")).trim();
  const chosen = ds[Number(pick) - 1];
  if (!chosen) {
    console.log("无效选择。");
    rl.close();
    return;
  }

  const rep = await tui.checkDataset(chosen.id);
  console.log(`\n检查 ${chosen.id}：共 ${rep.total} 题，可运行 ${rep.confirmed}，计划满分 ${rep.plannedMax}`);
  console.log(`  缺评分文件：${rep.missingScoring.join(", ") || "无"}`);
  console.log(`  缺图/坏图：${rep.missingImages.join(", ") || "无"}`);
  for (const e of rep.errors.slice(0, 10)) console.log(`  错误 ${e.questionId}: ${e.errors.join("; ")}`);

  const models = tui.loadModels();
  console.log("\n模型：");
  models.forEach((m, i) => console.log(`  ${i + 1}. ${m.profileId}/${m.modelId}  text=${m.capability.text} image=${m.capability.imageInput}`));
  const mPick = (await ask(rl, "选模型编号: ")).trim();
  const m = models[Number(mPick) - 1] ?? models[0]!;
  const modeAns = (await ask(rl, "模式 (1=without_tool 2=with_tool 3=双模式分别计分) [1]: ")).trim();
  const concAns = (await ask(rl, "同时答题数 [1]: ")).trim();
  const apiAns = (await ask(rl, "同时 API 请求数 (空=不限) [空]: ")).trim();
  const setup: Setup = {
    profileId: m.profileId,
    modelId: m.modelId,
    mode: modeAns === "3" ? "both" : modeAns === "2" ? "with_tool" : "without_tool",
    concurrency: Math.max(1, Number(concAns || "1")),
    ...(apiAns ? { apiConcurrency: Math.max(1, Number(apiAns)) } : {}),
  };
  tui.setSetup(setup);

  const go = (await ask(rl, `确认开始 ${chosen.id} / ${setup.mode} / ${setup.profileId}/${setup.modelId}？(y/n): `)).trim();
  if (go.toLowerCase() !== "y") {
    console.log("已取消。");
    rl.close();
    return;
  }

  const taskId = tui.start();
  if (!taskId) {
    console.log(tui.getState().message ?? "未能启动。");
    rl.close();
    return;
  }
  console.log(`\n运行 task=${taskId}（ Ctrl+C 停止 ）…`);
  tui.getService().subscribe(taskId, (e) => {
    const line = eventLine(e);
    if (line) console.log(line);
  });
  const status = await tui.getService().whenDone(taskId);
  for (const runId of status?.runIds ?? []) {
    await tui.openReport(runId);
    const scr = tui.getState().screen;
    if (scr.kind === "report") {
      const t = scr.report.totals;
      console.log(`\n成绩 ${scr.mode}: 确认 ${t.confirmedRaw}/${t.confirmedMax} (计划满分 ${t.plannedMax})`);
      console.log(`覆盖: ${JSON.stringify(scr.report.coverage)}`);
    }
    console.log(`\n报告目录: runs/${runId}`);
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
