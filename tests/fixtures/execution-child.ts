const { acquireExecutionLease } = process.argv.includes("--built")
  ? await import("../../dist/runner/execution-lock.js")
  : await import("../../src/runner/execution-lock.js");

try {
  const lease = await acquireExecutionLease();
  process.send?.({ status: "acquired", pid: process.pid, port: lease.port });
  process.once("message", async () => {
    await lease.release();
    process.disconnect();
  });
} catch (error) {
  process.send?.({ status: "refused", message: (error as Error).message });
  process.disconnect();
  process.exitCode = 2;
}
