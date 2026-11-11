/**
 * Real model acceptance / capability probe entry (AGENTS.md §11/§12). PAID and
 * network — gated. Refuses unless `--authorise-paid` + explicit `--scope` are
 * present. A single tiny request is placed only with `--probe` (add
 * `--probe-image` to also verify image input). Unknown cost is never zero.
 *
 *   npm run accept -- --scope longcat:LongCat-2.5-Preview --authorise-paid --probe [--probe-image]
 */
import sharp from "sharp";
import { loadModelsConfig, resolveApiKeyFromEnv } from "./providers/models-config.js";
import { createRegistry, resolveModel } from "./providers/pi-adapter.js";
import { probeModel } from "./providers/probe.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const authorised = process.argv.includes("--authorise-paid");
  const scope = argValue("--scope");

  if (!authorised) {
    console.error(
      "REFUSED: real model calls are paid and require explicit authorization.\n" +
        "Provide --authorise-paid and an explicit --scope <profileId:modelId>.",
    );
    return 2;
  }
  if (!scope || !scope.includes(":")) {
    console.error("REFUSED: --scope must be <profileId:modelId>.");
    return 2;
  }

  const [profileId, modelId] = scope.split(":");
  const config = loadModelsConfig("configs/models.json");
  const registry = createRegistry(config);
  const profile = registry.profilesById.get(profileId!);
  if (!profile) {
    console.error(`Unknown profile '${profileId}'.`);
    return 2;
  }
  const model = resolveModel(registry, profileId!, modelId!);
  if (!model) {
    console.error(`Profile '${profileId}' has no model '${modelId}'.`);
    return 2;
  }

  const hasKey = resolveApiKeyFromEnv(profile.auth.envVars) !== undefined;
  console.log(
    `Authorized scope: provider=${profile.provider} model=${model.id} baseUrl=${profile.baseUrl}\n` +
      `Credential env present: ${hasKey ? "yes" : "NO (set one of " + profile.auth.envVars.join(", ") + ")"}\n` +
      `Capabilities on record: ${JSON.stringify(profile.capability)}`,
  );
  if (!hasKey) {
    console.error("No credential in environment; cannot place a real request. Set the env var (never write the key to a file).");
    return 3;
  }

  if (!process.argv.includes("--probe")) {
    console.log("Registry + auth OK. Add --probe to place ONE tiny real request.");
    return 0;
  }

  console.log("\n--- text probe (1 tiny request, maxRetries:0) ---");
  const textRes = await probeModel(registry.models, model, { prompt: "Reply with exactly: pong" });
  console.log(JSON.stringify(textRes, null, 2));

  if (process.argv.includes("--probe-image")) {
    console.log("\n--- image probe (1 tiny request) ---");
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const imgRes = await probeModel(registry.models, model, {
      prompt: "What single color fills this image? Answer in one word.",
      images: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
    });
    console.log(JSON.stringify(imgRes, null, 2));
  }

  console.log(
    "\nRecord the REAL evidence (text/stopReason/usage/latency above) into configs capability before treating any capability as verified.",
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
