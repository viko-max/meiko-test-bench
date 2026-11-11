/**
 * Offline test harness built on Pi's official `faux` provider. Produces a fully
 * wired Agent (exam streamFn with forced maxRetries:0 + all runner hooks) that
 * streams scripted responses with NO network. Used to assert invariants
 * deterministically (AGENTS.md §10: offline mock isolates network only).
 */
import { fauxProvider, createModels, type FauxResponseStep, type Models, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { buildAgent } from "../../src/runner/agent-factory.js";
import { makeExamStreamFn } from "../../src/providers/stream-fn.js";
import { LimitGuard } from "../../src/runner/limits.js";
import { ProtectionLimitsSchema, type AnswerMode, type ProtectionLimits } from "../../src/shared/contracts.js";
import { InMemoryTrialRecorder } from "../../src/storage/recorder.js";
import { buildSystemPrompt } from "../../src/runner/prompts.js";

export interface FauxSetup {
  agent: Agent;
  model: Model<string>;
  recorder: InMemoryTrialRecorder;
  guard: LimitGuard;
  limits: ProtectionLimits;
  faux: ReturnType<typeof fauxProvider>;
  /** Options actually handed to Models.streamSimple (to assert maxRetries:0). */
  capturedOptions: () => SimpleStreamOptions | undefined;
}

export function setupFaux(
  responses: FauxResponseStep[],
  opts: { mode: AnswerMode; tools?: AgentTool[]; limits?: Partial<ProtectionLimits> },
): FauxSetup {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const model = faux.getModel();

  const limits = ProtectionLimitsSchema.parse(opts.limits ?? {});
  const guard = new LimitGuard(limits);
  const recorder = new InMemoryTrialRecorder();

  let captured: SimpleStreamOptions | undefined;
  const spyModels = {
    streamSimple: (m: Model<string>, c: Parameters<Models["streamSimple"]>[1], o?: SimpleStreamOptions) => {
      captured = o;
      return models.streamSimple(m, c, o);
    },
  } as unknown as Models;

  const streamFn = makeExamStreamFn(spyModels);
  const systemPrompt = buildSystemPrompt(opts.mode, (opts.tools ?? []).map((t) => t.name));

  const agent = buildAgent({
    streamFn,
    systemPrompt,
    model,
    tools: opts.tools ?? [],
    mode: opts.mode,
    limits,
    guard,
    recorder,
  });

  return { agent, model, recorder, guard, limits, faux, capturedOptions: () => captured };
}
