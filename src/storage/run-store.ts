/**
 * Durable run storage under runs/<run_id>/ (AGENTS.md §2/§6). Events and tool
 * records are append-only JSONL; the trial summary is an atomic snapshot so an
 * interrupt never forges a "complete" record. Old runs are never deleted.
 */
import { appendJsonl, ensureDir, pathJoin, writeJsonAtomic } from "../shared/json.js";
import type { TrialRecorder } from "./recorder.js";

export class RunStore {
  readonly runDir: string;

  constructor(runsRoot: string, runId: string) {
    this.runDir = pathJoin(runsRoot, runId);
    ensureDir(this.runDir);
  }

  writeRunSnapshot(value: unknown): void {
    writeJsonAtomic(pathJoin(this.runDir, "run.json"), value);
  }

  trialDir(trialId: string): string {
    const dir = pathJoin(this.runDir, "trials", trialId);
    ensureDir(dir);
    return dir;
  }

  recorderFor(trialId: string): TrialRecorder {
    const dir = this.trialDir(trialId);
    const eventsPath = pathJoin(dir, "events.jsonl");
    const requestsPath = pathJoin(dir, "requests.jsonl");
    const toolsPath = pathJoin(dir, "tools.jsonl");
    return {
      recordEvent: (e) => {
        // message_update is a streaming UI delta carrying the growing partial;
        // it is NOT a durable fact and caused O(n^2) log blowup on a runaway
        // generation. Persist only start/end/tool/agent events (message_end
        // carries the final content). Live UI still sees updates via subscribe.
        const type = (e as { type?: string }).type;
        if (type === "message_update") return;
        appendJsonl(eventsPath, { at: new Date().toISOString(), event: e });
      },
      recordRequest: (r) => appendJsonl(requestsPath, { at: new Date().toISOString(), request: r }),
      recordTool: (t) => appendJsonl(toolsPath, { at: new Date().toISOString(), tool: t }),
      setAnswerSheet: (text) => writeJsonAtomic(pathJoin(dir, "answer.json"), { trialId, answerSheet: text }),
    };
  }
}
