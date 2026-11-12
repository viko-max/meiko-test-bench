/** execute_python: run model-written Python in a local subprocess.
 *  LEGACY v1 工具实现（宿主任意代码、非隔离），未注册到当前正式工具集
 *  （当前正式 with_tool 为 v2-restricted 受限四工具，见 tools/index.ts）。保留仅作历史参考。 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.js";
import { runCommand, sanitizedEnv } from "./subprocess.js";

function format(title: string, r: Awaited<ReturnType<typeof runCommand>>): string {
  const parts = [`${title} exit=${r.exitCode ?? "null"} timedOut=${r.timedOut} aborted=${r.aborted} durationMs=${r.durationMs}`];
  if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`);
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
  if (r.outputTruncated) parts.push(`--- output truncated at byte limit ---`);
  return parts.join("\n");
}

export function executePythonTool(ctx: ToolContext): AgentTool {
  return {
    name: "execute_python",
    label: "Execute Python",
    description:
      "Run Python code in a local subprocess and return stdout, stderr, exit code and duration. " +
      "Files you write land in the trial work dir; public question attachments are readable from the public dir.",
    parameters: Type.Object({ code: Type.String() }),
    execute: async (_id, args, signal) => {
      const { code } = args as { code: string };
      const file = join(ctx.workDir, `script_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
      writeFileSync(file, code, "utf8");
      // Force UTF-8 IO so model code / libraries printing the emoji path don't
      // hit a GBK-console UnicodeEncodeError on this Windows host.
      const env = { ...sanitizedEnv(), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
      const res = await runCommand({
        cmd: ctx.pythonInterpreter,
        args: [file],
        cwd: ctx.workDir,
        env,
        timeoutMs: ctx.limits.perToolTimeoutMs,
        maxOutputBytes: ctx.limits.maxOutputBytes,
        signal,
      });
      const failed = res.exitCode !== 0 || res.timedOut || res.aborted;
      return {
        content: [{ type: "text", text: format("Python", res) }],
        details: { language: "python", script: file, ...res },
        ...(failed ? { isError: true } : {}),
      };
    },
  };
}
