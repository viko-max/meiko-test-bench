import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export interface ExecutionLease {
  readonly port: number;
  release(): Promise<void>;
}

const active = new WeakSet<ExecutionLease>();
const projectRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const identity = process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot;
export const executionLockPort = 20000 + createHash("sha256").update(identity).digest().readUInt32BE(0) % 20000;

export function assertExecutionLease(lease: ExecutionLease): void {
  if (!active.has(lease)) throw new Error("Invalid or released exam execution lease; no request was sent.");
}

export async function acquireExecutionLease(): Promise<ExecutionLease> {
  // 由操作系统独占端口；进程被强制终止也会释放，不依赖包装进程 PID 或日志更新时间。
  // 不选择备用端口，否则第二个进程会绕过互斥。端口被其他应用占用时同样拒绝执行。
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(new Error(
        `Exam execution refused: cannot acquire project lock on 127.0.0.1:${executionLockPort} (${error.code}). ` +
        "Another exam/probe may still be running. Do not restart based on a wrapper PID or stalled logs; " +
        "wait for the current task to finish, then resume with identical configuration. No request was sent.",
        { cause: error },
      ));
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: executionLockPort, exclusive: true }, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  let released: Promise<void> | undefined;
  const lease: ExecutionLease = {
    port: executionLockPort,
    release() {
      if (released) return released;
      active.delete(lease);
      released = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return released;
    },
  };
  active.add(lease);
  return lease;
}

export async function withExecutionLease<T>(fn: (lease: ExecutionLease) => Promise<T>): Promise<T> {
  const lease = await acquireExecutionLease();
  try {
    return await fn(lease);
  } finally {
    await lease.release();
  }
}
