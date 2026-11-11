/**
 * Durable JSON/JSONL IO: atomic complete-snapshots + append-only event logs,
 * so an interrupt never forges a "complete" record (AGENTS.md §2/§11).
 */
import { mkdirSync, renameSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Write JSON atomically: temp file in the same dir, then rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  const text = JSON.stringify(value, null, 2) + "\n";
  appendFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Read + parse JSON, or undefined if absent. */
export function readJson<T = unknown>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Append one JSONL event line. */
export function appendJsonl(path: string, value: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(value) + "\n", "utf8");
}

/** Read a JSONL file into records; blank lines skipped. */
export function readJsonl<T = unknown>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/** Join helper re-export for convenience. */
export const pathJoin = join;
