/**
 * Load + validate configs/models.json. Only environment variable NAMES are
 * allowed; any credential-shaped value or secret-bearing key is rejected.
 */
import { readFileSync } from "node:fs";
import { ModelsConfigSchema, type ModelsConfig } from "../shared/contracts.js";
import { assertNoCredentials } from "../shared/creds.js";

/** Recursively drop `$`-prefixed documentation keys (e.g. `$comment`). */
function stripDocKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDocKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!k.startsWith("$")) out[k] = stripDocKeys(v);
    }
    return out;
  }
  return value;
}

export function loadModelsConfig(path: string): ModelsConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertNoCredentials(parsed, path);
  return ModelsConfigSchema.parse(stripDocKeys(parsed));
}

/** Resolve the first present API key from a profile's env-var names. */
export function resolveApiKeyFromEnv(envVars: string[]): string | undefined {
  for (const name of envVars) {
    const v = process.env[name];
    if (v && v.length > 0) return v;
  }
  return undefined;
}
