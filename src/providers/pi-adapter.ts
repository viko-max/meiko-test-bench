/**
 * Pi model-access adapter (AGENTS.md §6). Builds a Models registry from our
 * ModelProfiles via createProvider + envApiKeyAuth, supporting official and
 * custom OpenAI-compatible / Anthropic-messages endpoints. Saves the real
 * provider / baseUrl / model id — never just a display name.
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { stream as ocStream, streamSimple as ocStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as amStream, streamSimple as amStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ModelEntry, ModelProfile, ModelsConfig } from "../shared/contracts.js";

/** Stream implementations per supported api id. */
function streamsForApi(api: string): ProviderStreams {
  switch (api) {
    case "openai-completions":
      return { stream: ocStream, streamSimple: ocStreamSimple } as unknown as ProviderStreams;
    case "anthropic-messages":
      return { stream: amStream, streamSimple: amStreamSimple } as unknown as ProviderStreams;
    default:
      throw new Error(`Unsupported api for custom provider: ${api}. Add its stream wiring in pi-adapter.ts.`);
  }
}

/** Construct a full Pi Model from our ModelEntry + profile. */
function toProviderModel(entry: ModelEntry, profile: ModelProfile): Model<Api> {
  const rates = profile.pricing;
  const url = new URL(profile.baseUrl);
  const officialSpark = profile.api === "openai-completions" && entry.id === "spark-x2.6"
    && url.origin === "https://maas-api.cn-huabei-1.xf-yun.com"
    && ["/v2", "/v2/"].includes(url.pathname) && !url.search && !url.hash;
  return {
    id: entry.id,
    name: entry.name,
    api: profile.api,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    input: entry.input,
    reasoning: officialSpark || entry.reasoning,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    // 星火官方 Chat 协议仅承诺思考开关；复用 Pi 的 thinking.type 编码，不发送 reasoning_effort。
    ...(officialSpark ? {
      thinkingLevelMap: { minimal: null, low: null, medium: null },
      compat: {
        supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
        thinkingFormat: "deepseek", maxTokensField: "max_completion_tokens",
      },
    } : {}),
    // Rate table for calculateCost; zeros mean "not claimed". Actual estimated
    // cost in reports uses profile.pricing and stays unknown when unverified.
    cost: {
      input: rates?.inputPerMTok ?? 0,
      output: rates?.outputPerMTok ?? 0,
      cacheRead: rates?.cacheReadPerMTok ?? 0,
      cacheWrite: rates?.cacheWritePerMTok ?? 0,
    },
  } as Model<Api>;
}

export function buildProvider(profile: ModelProfile): Provider {
  const models = profile.models.map((m) => toProviderModel(m, profile));
  return createProvider({
    id: profile.provider,
    name: profile.displayName,
    baseUrl: profile.baseUrl,
    auth: { apiKey: envApiKeyAuth(profile.provider, profile.auth.envVars) },
    models,
    api: streamsForApi(profile.api),
  });
}

export interface Registry {
  models: MutableModels;
  profilesById: Map<string, ModelProfile>;
}

export function createRegistry(config: ModelsConfig): Registry {
  const models = createModels();
  const profilesById = new Map<string, ModelProfile>();
  const seenProviders = new Set<string>();
  for (const profile of config.profiles) {
    // P1-6: two profiles sharing a provider id would silently cross-wire
    // endpoints (models.setProvider overwrites the earlier one). Distinct
    // endpoints MUST use distinct provider ids — reject the ambiguous config
    // rather than record one endpoint while calling another.
    if (seenProviders.has(profile.provider)) {
      throw new Error(`duplicate provider id '${profile.provider}' (profile '${profile.id}'); distinct endpoints must use distinct provider ids`);
    }
    seenProviders.add(profile.provider);
    models.setProvider(buildProvider(profile));
    profilesById.set(profile.id, profile);
  }
  return { models, profilesById };
}

/** Look up a concrete model by our profile id + model id. */
export function resolveModel(registry: Registry, profileId: string, modelId: string): Model<Api> | undefined {
  const profile = registry.profilesById.get(profileId);
  if (!profile) return undefined;
  return registry.models.getModel(profile.provider, modelId);
}
