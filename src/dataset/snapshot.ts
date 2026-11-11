/**
 * Dataset snapshot (AGENTS.md §2; v0.2 §7.3). A confirmed snapshot freezes the
 * public question set + scoring version for a run identity. Any change to a
 * stem, attachment, or scoring basis produces a NEW version; used snapshots are
 * never overwritten.
 */
import { sha256OfJsonable } from "../shared/hashing.js";
import type { ImportedEntry } from "./import.js";

export interface DatasetSnapshot {
  datasetId: string;
  version: string;
  status: "draft" | "confirmed";
  questionIds: string[];
  publicDigest: string;
  scoringVersion: string;
  createdAt: string;
}

/** Build a snapshot from imported entries. Only error-free, confirmed entries count. */
export function buildSnapshot(
  datasetId: string,
  version: string,
  entries: ImportedEntry[],
  status: "draft" | "confirmed",
  now: string,
): DatasetSnapshot {
  const usable = entries
    .filter((e) => e.question && e.errors.length === 0)
    .sort((a, b) => a.questionId.localeCompare(b.questionId));

  const questionIds = usable.map((e) => e.questionId);
  const publicDigest = sha256OfJsonable(
    usable.map((e) => ({ id: e.questionId, digest: e.contentDigest ?? "", scoring: e.scoring ?? null })),
  );

  const scoringVersions = new Set(usable.map((e) => e.scoring?.scoringVersion).filter((v): v is string => !!v));
  const scoringVersion = scoringVersions.size === 1 ? [...scoringVersions][0]! : scoringVersions.size === 0 ? "none" : "mixed";

  return { datasetId, version, status, questionIds, publicDigest, scoringVersion, createdAt: now };
}
