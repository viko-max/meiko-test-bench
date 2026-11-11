/**
 * Identifier rules + run/trial identity (AGENTS.md §2/§7).
 * Identifiers are lowercase ASCII so they are safe as file/dir names.
 */
import { shortDigest } from "./hashing.js";

/** dataset ids, question ids: lowercase ASCII letters, digits, `_`, `.`, `-`. */
const IDENT_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

/** Version tokens: content changes bump the version; never overwrite. */
const VERSION_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function isValidIdentifier(value: string): boolean {
  return IDENT_RE.test(value);
}

export function requireIdentifier(value: string, label: string): string {
  if (!isValidIdentifier(value)) {
    throw new Error(`${label} must be lowercase ASCII [a-z0-9_.-], got: ${JSON.stringify(value)}`);
  }
  return value;
}

export function requireVersion(value: string, label: string): string {
  if (!VERSION_RE.test(value)) {
    throw new Error(`${label} must be a version token [a-z0-9_.-], got: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Fields that make up a run/trial identity. A change to any of them means a new
 * run/trial — never reuse or merge results across identities (AGENTS.md §7).
 */
export interface TrialIdentity {
  datasetId: string;
  datasetVersion: string;
  questionId: string;
  questionVersion: string;
  provider: string;
  modelId: string;
  mode: "without_tool" | "with_tool";
  configDigest: string;
  promptVersion: string;
  toolsVersion: string;
  /** P1-C: question CONTENT digest (stem + attachments). Same version but changed
   *  content -> a NEW identity, so an old answer is never reused. */
  questionContentDigest?: string;
}

/** Deterministic, collision-resistant trial id. Never hand-written. */
export function deriveTrialId(identity: TrialIdentity, index: number): string {
  const base = [
    identity.datasetId,
    identity.datasetVersion,
    identity.questionId,
    identity.questionVersion,
    identity.provider,
    identity.modelId,
    identity.mode,
    identity.configDigest,
    identity.promptVersion,
    identity.toolsVersion,
    ...(identity.questionContentDigest ? [identity.questionContentDigest] : []),
  ].join(":");
  return `${identity.questionId}__${identity.mode}__${shortDigest(base)}__${index}`;
}

export interface RunIdentity {
  datasetId: string;
  datasetVersion: string;
  provider: string;
  modelId: string;
  configDigest: string;
}

export function deriveRunId(identity: RunIdentity): string {
  const base = [identity.datasetId, identity.datasetVersion, identity.provider, identity.modelId, identity.configDigest].join(":");
  return `${identity.datasetId}@${identity.datasetVersion}__${identity.provider}__${identity.modelId}__${shortDigest(base, 10)}`;
}

/**
 * Run-level config identity for the answering digest (P1-3). Includes the ACTUAL
 * endpoint (baseUrl), api, and resolved model entry, so the same modelId on a
 * different endpoint or model config is a DIFFERENT identity and is never mixed.
 */
export interface RunConfigIdentity {
  datasetId: string;
  datasetVersion: string;
  provider: string;
  modelId: string;
  mode: "without_tool" | "with_tool";
  promptVersion: string;
  toolsVersion: string;
  baseUrl: string;
  api: string;
  model: { id: string; contextWindow: number; maxTokens: number; input: string[]; reasoning: boolean };
  limits: unknown;
  thinkingLevel?: string;
  thinkingConfig?: unknown;
  executionPolicyVersion?: string;
}
export function computeConfigDigest(identity: RunConfigIdentity): string {
  // 旧任务默认 off；显式 off 与省略应具有同一身份。
  const { thinkingLevel, ...base } = identity;
  return shortDigest(thinkingLevel && thinkingLevel !== "off" ? { ...base, thinkingLevel } : base);
}
