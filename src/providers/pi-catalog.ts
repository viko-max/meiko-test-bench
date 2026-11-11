/**
 * Pi built-in provider catalog MERGED with our custom model profiles.
 *
 * Enumerates pi's built-in providers/models (getBuiltinProviders / getBuiltinModels)
 * plus our configs/models.json custom endpoints, marks each provider runnable
 * when its API-key env var is set, and provides a merged registry
 * (pi builtinModels + custom) so a selected model — built-in OR custom —
 * resolves and runs. Built-in models get a synthesized ModelProfile on demand
 * so the run path's profilesById carries capability/baseUrl/api for them.
 */
import { getBuiltinProviders, getBuiltinModels, builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { Capability, ModelEntry, ModelProfile, ModelsConfig } from "../shared/contracts.js";
import { buildProvider, type Registry } from "./pi-adapter.js";

export interface CatalogModel {
  profileId: string;
  providerId: string;
  modelId: string;
  displayName: string;
  api: string;
  baseUrl?: string;
  imageInput: boolean;
  reasoning: boolean;
  contextWindow?: number;
  source: "builtin" | "custom";
}

export interface ProviderGroup {
  providerId: string;
  displayName: string;
  source: "builtin" | "custom";
  /** True when at least one API-key env var for this provider is set. */
  runnable: boolean;
  keyEnv?: string;
  models: CatalogModel[];
}

/** pi resolves a provider's key from `<PROVIDER>_API_KEY` (dashes -> underscores). */
export function keyEnvFor(providerId: string): string {
  return providerId.toUpperCase().replace(/-/g, "_") + "_API_KEY";
}

function anyKeySet(envVars: string[]): boolean {
  return envVars.some((v) => Boolean(process.env[v]));
}

/** Enumerate pi built-in providers + our custom profiles, merged (custom wins
 *  on a shared provider id). Custom + runnable groups sort first. */
export function listProviderGroups(config: ModelsConfig): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const customProviderIds = new Set(config.profiles.map((p) => p.provider));
  for (const providerId of getBuiltinProviders()) {
    const raw = getBuiltinModels(providerId) as unknown as Array<Record<string, unknown>>;
    if (raw.length === 0) continue;
    const keyEnv = keyEnvFor(providerId);
    groups.push({
      providerId,
      displayName: providerId,
      source: customProviderIds.has(providerId) ? "custom" : "builtin",
      runnable: anyKeySet([keyEnv]),
      keyEnv,
      models: raw.map((m) => {
        const input = Array.isArray(m.input) ? (m.input as string[]) : ["text"];
        return {
          profileId: providerId,
          providerId,
          modelId: String(m.id),
          displayName: String(m.name ?? m.id),
          api: String(m.api ?? ""),
          baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : undefined,
          imageInput: input.includes("image"),
          reasoning: Boolean(m.reasoning),
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
          source: "builtin" as const,
        };
      }),
    });
  }
  for (const profile of config.profiles) {
    const models: CatalogModel[] = profile.models.map((m) => ({
      profileId: profile.id,
      providerId: profile.provider,
      modelId: m.id,
      displayName: m.name,
      api: profile.api,
      baseUrl: profile.baseUrl,
      imageInput: m.input.includes("image"),
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      source: "custom" as const,
    }));
    const existing = groups.find((g) => g.providerId === profile.provider);
    if (existing) {
      // 注册表按 provider 整体覆盖；目录只能显示该自定义端点实际配置的模型。
      existing.models = models;
      existing.displayName = profile.displayName;
      existing.source = "custom";
      existing.runnable = anyKeySet(profile.auth.envVars);
      existing.keyEnv = profile.auth.envVars[0];
    } else {
      groups.push({
        providerId: profile.provider,
        displayName: profile.displayName,
        source: "custom",
        runnable: anyKeySet(profile.auth.envVars),
        keyEnv: profile.auth.envVars[0],
        models,
      });
    }
  }
  groups.sort(
    (a, b) =>
      (a.source === b.source ? 0 : a.source === "custom" ? -1 : 1) ||
      (Number(b.runnable) - Number(a.runnable)) ||
      a.providerId.localeCompare(b.providerId),
  );
  return groups;
}

/** Registry with pi built-in providers + our custom profiles (custom overrides
 *  a built-in sharing its provider id). Distinct custom provider ids required. */
export function createMergedRegistry(config: ModelsConfig): Registry {
  const models = builtinModels() as unknown as MutableModels;
  const profilesById = new Map<string, ModelProfile>();
  const seen = new Set<string>();
  for (const profile of config.profiles) {
    if (seen.has(profile.provider)) {
      throw new Error(`duplicate provider id '${profile.provider}' (profile '${profile.id}'); distinct endpoints must use distinct provider ids`);
    }
    seen.add(profile.provider);
    models.setProvider(buildProvider(profile));
    profilesById.set(profile.id, profile);
  }
  return { models, profilesById };
}

/** Synthesize a ModelProfile for a pi built-in model so the run path's
 *  profilesById has capability/baseUrl/api. Returns undefined if unknown. */
export function synthesizeBuiltinProfile(providerId: string, modelId: string): ModelProfile | undefined {
  const raw = getBuiltinModels(providerId as Parameters<typeof getBuiltinModels>[0]) as unknown as Array<Record<string, unknown>>;
  const m = raw.find((x) => String(x.id) === modelId);
  if (!m) return undefined;
  const input = Array.isArray(m.input) ? (m.input as string[]) : ["text"];
  const entry: ModelEntry = {
    id: String(m.id),
    name: String(m.name ?? m.id),
    input: input.filter((v): v is "text" | "image" => v === "text" || v === "image"),
    reasoning: Boolean(m.reasoning),
    contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 128000,
    maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : 8192,
  };
  const capability: Capability = {
    text: "verified",
    imageInput: entry.input.includes("image") ? "verified" : "unsupported",
    toolCalling: "unverified",
    imageToolResult: "unverified",
    usage: "unverified",
    nativeWebSearch: "unverified",
    verificationEvidence: `pi built-in catalog: ${providerId}/${modelId} (api=${String(m.api ?? "")})`,
  };
  return {
    id: providerId,
    displayName: `${providerId} (pi 内置目录)`,
    provider: providerId,
    api: String(m.api ?? ""),
    baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : "https://example.invalid/v1",
    auth: { envVars: [keyEnvFor(providerId)] },
    models: [entry],
    capability,
  };
}
