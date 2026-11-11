import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { VersionSchema } from "../shared/contracts.js";
import { resolvePublicAttachment } from "../tools/paths.js";

export function readDatasetVersion(datasetDir: string, datasetId: string): string {
  if (!existsSync(join(datasetDir, "VERSION.json"))) return "1";
  const record = z.object({ datasetId: z.literal(datasetId), version: VersionSchema, status: z.literal("confirmed") })
    .passthrough().parse(JSON.parse(readFileSync(resolvePublicAttachment(datasetDir, "VERSION.json"), "utf8")));
  return record.version;
}
