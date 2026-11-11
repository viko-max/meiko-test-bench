import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TaskControlService } from "../src/service/task-service.js";

function fixture() {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "task-history-order-"));
  const add = (id: string, metadata?: unknown) => {
    const dir = join(root, id);
    mkdirSync(join(dir, "trials"), { recursive: true });
    if (metadata !== undefined) writeFileSync(join(dir, "run.json"), typeof metadata === "string" ? metadata : JSON.stringify(metadata));
    return dir;
  };
  return { root, add, service: new TaskControlService() };
}

describe("历史任务按实际开始时间选择最近记录", () => {
  it("模型名和目录字典序不决定最近任务", () => {
    const s = fixture();
    s.add("a-old", { startedAt: "2026-10-01T01:00:00Z" });
    s.add("z-new", { startedAt: "2026-10-28T01:00:00Z" });
    const tasks = s.service.listTasks(s.root);
    expect(tasks.map((task) => task.runId)).toEqual(["z-new", "a-old"]);
    expect(tasks[0]?.startedAt).toBe("2026-10-28T01:00:00Z");
  });
  it("离线重评分写入报告不改变原来的任务顺序", () => {
    const s = fixture();
    const old = s.add("old", { startedAt: "2026-10-01T01:00:00Z" });
    s.add("new", { startedAt: "2026-10-28T01:00:00Z" });
    writeFileSync(join(old, "report.json"), JSON.stringify({ updatedAt: "2026-11-01T01:00:00Z" }));
    expect(s.service.listTasks(s.root).map((task) => task.runId)).toEqual(["new", "old"]);
  });
  it("无日期、坏 JSON 和非法日期的历史保留在末尾，缺失日期不伪造", () => {
    const s = fixture();
    s.add("a-unknown"); s.add("b-broken", "{"); s.add("c-invalid", { startedAt: "invalid" });
    s.add("z-valid", { startedAt: "2026-10-28T01:00:00Z" });
    const tasks = s.service.listTasks(s.root);
    expect(tasks.map((task) => task.runId)).toEqual(["z-valid", "a-unknown", "b-broken", "c-invalid"]);
    expect(tasks.slice(1).every((task) => task.startedAt === undefined)).toBe(true);
  });
  it("时间相同时稳定排序，时间的时区偏移按实际时刻比较", () => {
    const s = fixture();
    s.add("b", { startedAt: "2026-10-28T10:00:00+08:00" });
    s.add("a", { startedAt: "2026-10-28T02:00:00Z" });
    s.add("c", { startedAt: "2026-10-28T02:01:00Z" });
    expect(s.service.listTasks(s.root).map((task) => task.runId)).toEqual(["c", "a", "b"]);
  });
});
