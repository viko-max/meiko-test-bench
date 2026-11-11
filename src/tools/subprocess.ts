/**
 * Local subprocess runner for model-written code (AGENTS.md §9). NOT strong
 * isolation: this controls time, output size and process-tree termination, and
 * strips the harness's API-key env vars before exec — it does NOT prevent the
 * code from reading other paths or reaching the network.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { boundedUtf8 } from "../shared/utf8.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  outputTruncated: boolean;
  durationMs: number;
}

export interface RunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Windows needs shell for .cmd (tsc). Set true when invoking npm/.cmd shims. */
  shell?: boolean;
}

const SECRET_ENV_RE = /(API_KEY|APIKEY|SECRET|TOKEN|CREDENTIAL|PASSWORD|PASSWD|BEARER|PRIVATE_KEY|AUTHORIZATION)/i;

/** Copy the environment minus credential-shaped variables. */
export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (SECRET_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Kill a process and its whole tree. Windows uses taskkill /T /F. */
export function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid == null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      /* best effort */
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

class OutputCollector {
  private bytes = 0;
  private textBytes = 0;
  private readonly decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
  stdout = "";
  stderr = "";
  truncated = false;
  constructor(private readonly max: number) {}
  push(which: "out" | "err", chunk: Buffer): void {
    if (this.bytes >= this.max) {
      this.truncated = true;
      return;
    }
    const remaining = this.max - this.bytes;
    const accepted = chunk.subarray(0, remaining);
    this.bytes += accepted.length;
    this.append(which, this.decoders[which].write(accepted));
    if (accepted.length < chunk.length) this.truncated = true;
  }
  private append(which: "out" | "err", text: string): void {
    const bounded = boundedUtf8(text, this.max - this.textBytes);
    this.textBytes += bounded.bytes;
    if (which === "out") this.stdout += bounded.text;
    else this.stderr += bounded.text;
    this.truncated ||= bounded.truncated;
  }
  finish(): void {
    // 达到字节边界时不补出被截断字符的替代符；完整输出才冲刷解码器。
    if (!this.truncated) for (const which of ["out", "err"] as const) this.append(which, this.decoders[which].end());
  }
}

export function runCommand(opts: RunOptions): Promise<RunResult> {
  if (!Number.isSafeInteger(opts.maxOutputBytes) || opts.maxOutputBytes <= 0) throw new Error("maxOutputBytes must be a positive safe integer");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("timeoutMs must be positive and finite");
  const started = Date.now();
  return new Promise<RunResult>((resolve) => {
    const collector = new OutputCollector(opts.maxOutputBytes);
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? sanitizedEnv(),
      shell: opts.shell ?? false,
      windowsHide: true,
    });

    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      collector.finish();
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: collector.stdout,
        stderr: collector.stderr,
        exitCode,
        timedOut,
        aborted,
        outputTruncated: collector.truncated,
        durationMs: Date.now() - started,
      });
    };

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (c: Buffer) => collector.push("out", c));
    child.stderr?.on("data", (c: Buffer) => collector.push("err", c));
    child.on("error", (err) => {
      collector.push("err", Buffer.from(`spawn error: ${err.message}\n`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
