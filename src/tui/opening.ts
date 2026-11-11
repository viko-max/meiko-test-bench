import type { EntrancePose, MascotColorway } from "./mascot.js";

export const OPENING_DURATION_MS = 2000;
export const OPENING_TICK_MS = 50;
export const PAGE_ENTRANCE_DURATION_MS = 1500;

/** 时间线仅控制视觉动作；不表示初始化或任务进度。 */
export function openingBeat(elapsed: number): { frame: EntrancePose; walk: number; reveal: number; settle: number } {
  const time = Math.max(0, elapsed);
  let frame: EntrancePose = "idle";
  if (time >= 550 && time < 1100) {
    if (time >= 700 && time < 800) frame = "blink";
    else if (time >= 650 && time < 850) frame = "halfBlink";
    else if (time >= 850 && time < 1000) frame = "tailUp";
    else frame = "tailMid";
  }
  return {
    frame,
    walk: 1 - (1 - Math.min(1, time / 350)) ** 2,
    reveal: Math.max(0, Math.min(1, (time - 350) / 650)),
    settle: Math.max(0, Math.min(1, (time - 1250) / (OPENING_DURATION_MS - 1250))),
  };
}

export function pageEntrancePose(colorway: Exclude<MascotColorway, "orange">, time: number): EntrancePose {
  if (time < 200) return "idle";
  if (colorway === "pink") {
    if (time >= 950) return "idle";
    return time >= 450 && time < 700 ? "waveOut" : "waveIn";
  }
  if (time < 550) return "lookRight";
  return time < 850 ? "nod" : "idle";
}
