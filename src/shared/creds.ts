/**
 * Credential-shape scanning (AGENTS.md §4). Two layers:
 *  - value shapes: only concrete secret-looking VALUES (sk-…, cmk_…, JWT, PEM…)
 *  - key names: object keys that would themselves carry a secret (apiKey, token…)
 * Environment variable NAMES (e.g. PI_EXAM_STEPFUN_API_KEY) are values under an
 * `envVars` key and must NOT be flagged.
 */
import { CredentialInConfigError } from "./errors.js";

const VALUE_PATTERNS: Array<[string, RegExp]> = [
  ["anysearch", /\bas_sk_[A-Za-z0-9_-]{16,}/],
  ["openai-style-sk", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["chillmagic-cmk", /\bcmk_[A-Za-z0-9_-]{16,}/],
  ["github-pat", /\b(ghp|github_pat)_[A-Za-z0-9_-]{16,}/],
  ["aws-akia", /\bAKIA[0-9A-Z]{12,}/],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/],
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{20,}/],
];

const FORBIDDEN_KEY_NAMES = new Set([
  "apikey",
  "api_key",
  "access_key",
  "accesskey",
  "secret",
  "secret_key",
  "token",
  "access_token",
  "refresh_token",
  "password",
  "passwd",
  "authorization",
  "bearer",
  "private_key",
  "privatekey",
  "credentials",
  "client_secret",
]);

/** Return list of matched value-shape labels inside arbitrary text. */
export function scanValueShapes(text: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of VALUE_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

/** Recursively collect forbidden key names (case-insensitive) in an object tree. */
export function scanKeyNames(value: unknown, path = "$"): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...scanKeyNames(v, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_NAMES.has(k.toLowerCase())) hits.push(`${path}.${k}`);
      hits.push(...scanKeyNames(v, `${path}.${k}`));
    }
  }
  return hits;
}

/**
 * Assert a config/data object carries no credential values or secret-bearing
 * keys. Throws CredentialInConfigError on any hit.
 */
export function assertNoCredentials(value: unknown, where: string): void {
  const keyHits = scanKeyNames(value);
  const valueHits = scanValueShapes(JSON.stringify(value));
  if (keyHits.length > 0 || valueHits.length > 0) {
    throw new CredentialInConfigError(where, [...keyHits, ...valueHits.map((v) => `value:${v}`)]);
  }
}
