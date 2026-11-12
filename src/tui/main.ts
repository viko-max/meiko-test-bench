/**
 * TUI entry. Interactive exam flow: 选择题集 → 检查输入 → 选模型与模式 →
 * 确认任务 → 运行/停止 → 查看记录 → 恢复 → 分模式成绩。The TUI only renders the
 * ExamTui controller + forwards keys (AGENTS.md §3); real (paid) runs require
 * --authorise-paid. The alternate-screen visual acceptance (Chinese, scrolling,
 * keyboard, resize, terminal restore) is a Windows-terminal step.
 */
import { runExamTui } from "./app.js";
import { join } from "node:path";
import { createDemoRegistry } from "../providers/offline-demo.js";

async function main(): Promise<void> {
  const demo = process.argv.includes("--demo");
  const authorisePaid = process.argv.includes("--authorise-paid");
  if (demo && authorisePaid) throw new Error("离线演示无需付费授权，请移除 --authorise-paid。");
  const demoRoot = join(".work", "offline-demo");
  const sourcePath = join("datasets", "demo");
  await runExamTui({
    datasetsRoot: demo ? join(demoRoot, "datasets") : "datasets",
    modelsConfigPath: demo ? join(demoRoot, "models.json") : "configs/models.json",
    runsRoot: demo ? join(demoRoot, "runs") : "runs",
    workRoot: demo ? join(demoRoot, "trials") : ".work",
    ...(demo ? {
      importRoot: join(demoRoot, "drafts"),
      offlineDemo: { sourcePath, registry: await createDemoRegistry(sourcePath) },
    } : {}),
    toolsVersion: "v1",
    pythonInterpreter: "pyenv/.venv/Scripts/python.exe",
    limitsPath: "configs/limits.json",
    authorisePaid,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
