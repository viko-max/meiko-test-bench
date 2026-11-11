/**
 * TUI entry. Interactive exam flow: 选择题集 → 检查输入 → 选模型与模式 →
 * 确认任务 → 运行/停止 → 查看记录 → 恢复 → 分模式成绩。The TUI only renders the
 * ExamTui controller + forwards keys (AGENTS.md §3); real (paid) runs require
 * --authorise-paid. The alternate-screen visual acceptance (Chinese, scrolling,
 * keyboard, resize, terminal restore) is a Windows-terminal step.
 */
import { runExamTui } from "./app.js";

async function main(): Promise<void> {
  await runExamTui({
    datasetsRoot: "datasets",
    modelsConfigPath: "configs/models.json",
    runsRoot: "runs",
    workRoot: ".work",
    toolsVersion: "v1",
    pythonInterpreter: "pyenv/.venv/Scripts/python.exe",
    limitsPath: "configs/limits.json",
    authorisePaid: process.argv.includes("--authorise-paid"),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
