/**
 * Deterministic hashing + canonical JSON. Used for content digests, snapshot
 * versions, and run/trial identity. Never used to store secrets.
 */
import { createHash } from "node:crypto";

export type HexSha256 = string;

const HEX256 = /^[0-9a-f]{64}$/;

export function sha256OfBytes(bytes: Uint8Array): HexSha256 {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256OfText(text: string): HexSha256 {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical JSON: stable key order, no insignificant whitespace, UTF-8. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256OfJsonable(value: unknown): HexSha256 {
  return sha256OfText(canonicalJson(value));
}

/** Accept only 64-char lowercase hex; reject uppercase to avoid filename case mix-ups. */
export function requireSha256Hex(value: string): HexSha256 {
  if (!HEX256.test(value)) {
    throw new Error(`Not a 64-char lowercase hex sha256: ${value}`);
  }
  return value;
}

/** Short, filesystem-safe digest for run/trial ids. */
export function shortDigest(value: unknown, len = 12): string {
  return sha256OfJsonable(value).slice(0, len);
}
