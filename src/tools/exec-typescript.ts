/** execute_typescript: compile model-written TS with the project-local tsc, then run it.
 *  Compiled to an ES2022 module so it runs correctly under this project's
 *  "type": "module" (a CommonJS build would throw "exports is not defined" when
 *  executed inside the project's .work dir). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.js";
import { runCommand } from "./subprocess.js";

export function executeTypeScriptTool(ctx: ToolContext): AgentTool {
  return {
    name: "execute_typescript",
    label: "Execute TypeScript",
    description:
      "Compile TypeScript with the project-local compiler and run the result in Node. " +
      "Returns compile diagnostics (if any), stdout, stderr, exit code and duration.",
    parameters: Type.Object({ code: Type.String() }),
    execute: async (_id, args, signal) => {
      const { code } = args as { code: string };
      const base = `ts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const tsFile = join(ctx.workDir, `${base}.ts`);
      writeFileSync(tsFile, code, "utf8");

      const compile = await runCommand({
        cmd: ctx.nodePath,
        args: [ctx.tscEntry, "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "bundler", "--outDir", ctx.workDir, tsFile],
        cwd: ctx.workDir,
        timeoutMs: ctx.limits.perToolTimeoutMs,
        maxOutputBytes: ctx.limits.maxOutputBytes,
        signal,
      });

      if (compile.exitCode !== 0) {
        const text =
          `TypeScript compile FAILED (exit=${compile.exitCode ?? "null"})\n` +
          `--- tsc stdout ---\n${compile.stdout}\n--- tsc stderr ---\n${compile.stderr}`;
        return { content: [{ type: "text", text }], details: { language: "typescript", stage: "compile", compile }, isError: true };
      }

      const jsFile = join(ctx.workDir, `${base}.js`);
      const run = await runCommand({
        cmd: ctx.nodePath,
        args: [jsFile],
        cwd: ctx.workDir,
        timeoutMs: ctx.limits.perToolTimeoutMs,
        maxOutputBytes: ctx.limits.maxOutputBytes,
        signal,
      });
      const failed = run.exitCode !== 0 || run.timedOut || run.aborted;
      const parts = [`TypeScript run exit=${run.exitCode ?? "null"} timedOut=${run.timedOut} aborted=${run.aborted} durationMs=${run.durationMs}`];
      if (run.stdout) parts.push(`--- stdout ---\n${run.stdout}`);
      if (run.stderr) parts.push(`--- stderr ---\n${run.stderr}`);
      if (run.outputTruncated) parts.push(`--- output truncated at byte limit ---`);
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { language: "typescript", stage: "run", tsFile, jsFile, compile, run },
        ...(failed ? { isError: true } : {}),
      };
    },
  };
}
