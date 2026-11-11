import { setImmediate } from "node:timers/promises";

export async function stopExamTerminal(terminal: { stop(): void }): Promise<void> {
  if (process.platform === "win32" && process.stdin.isTTY) {
    // Windows 的 pause 需要先让出事件循环；同一输入回调内恢复 raw mode 会阻塞后续回调与自然退出。
    process.stdin.pause();
    await setImmediate();
  }
  terminal.stop();
}
