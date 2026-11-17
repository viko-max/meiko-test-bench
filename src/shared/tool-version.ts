/**
 * 工具版本的人类可读展示（报告、确认页、成绩页共用）。
 * 只描述存档记录中的真实版本，不虚构未知版本的能力。
 */
import type { AnswerMode } from "./contracts.js";

/** 工具版本不同时能力不同，跨版本成绩不做直接比较。 */
export const TOOL_VERSION_COMPARABILITY = "不同工具版本能力不同，成绩不直接比较";

export function describeToolVersion(mode: AnswerMode, version: string): string {
  if (mode === "without_tool") return `${version}（无工具）`;
  if (version === "v1") return "v1（宿主任意代码，非隔离）";
  if (version === "v2-restricted") return "v2-restricted（受限计算、附件与图像工具）";
  return version; // 未知版本原样显示，不虚构能力
}
