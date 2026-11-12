/**
 * Deterministic objective grading (AGENTS.md §8; v0.2 §12). Extract candidates
 * with clear textual evidence from a FREE-FORM answer sheet, then judge against
 * the scoring spec. Conservative: contradictory, disjunctive, uncertain, revised
 * or unit-mismatched answers become PENDING_HUMAN_REVIEW or INCORRECT — never a
 * guessed full mark.
 *
 * Choice grading (P1-A / P1-A2 / P1-3): a clear FINAL declaration (Answer:/boxed/
 * 故选) is the submission and WINS over incidental option letters in reasoning.
 * Uniqueness, parallelism and uncertainty are judged WITHIN the final-answer
 * region (not the whole sheet): an earlier "I was not sure" no longer blocks a
 * clear final, while a final that itself lists "a or b" / "A and B" is not a
 * unique choice, and several \boxed letters are a genuine conflict. Two DIFFERENT
 * final declarations ("Answer: A. On reflection, answer: B.") stay pending.
 * Numeric keeps the strong/weak split + case-sensitive units + boxed-evidence.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { GradeItem, GradingStatus, PublicQuestion, ScoringSpec } from "../shared/contracts.js";

export const OBJECTIVE_GRADER_VERSION = "objective-v3";

export interface ObjectiveResult {
  judgement: "correct" | "incorrect" | "partial" | "pending";
  rawScore: number;
  maxScore: number;
  items: GradeItem[];
  reviewStatus: GradingStatus;
  evidence: string;
}

// ---------------- single / multi choice ----------------
const SELECTION_MARKERS =
  /(?:final\s+answer|correct\s+answer|答案为|答案是|正确答案|选项|answer|option|choice|答案|选)\s*(?:is|为|是)?\s*[：:]?\s*[（(]?[$*_\\]{0,4}\s*([A-Za-z])(?=[^A-Za-z0-9]|$)/gi;

// TEXT final-submission markers (boxed handled separately). Bare connectives
// (因此/therefore...) are NOT markers — they often precede a variable, not an option.
const TEXT_FINAL_CHOICE_RE = new RegExp(
  "(?:最终答案|最终选项|最终结果|最终|正确答案|答案是|答案为|final\\s+answer|correct\\s+answer|\\banswer\\b|correct\\s+(?:choice|option)|故选|应选)" +
    "\\s*(?:is|为|是)?\\s*[：:]?\\s*[（(]?[$*_\\\\{}\\\\s]*(?:\\\\text\\s*\\{)?\\s*([A-Za-z])(?![A-Za-z0-9])",
  "gi",
);

const BOXED_RE = /\\boxed\s*\{((?:[^{}]|\{[^{}]*\})*)\}|\\boxed\s+([A-Za-z0-9.\-+]+)/gi;
/** The LAST \boxed{...}: a number(+unit), or a letter from a bare single letter,
 *  a \text{}-wrapped one, or a leading \boxed{\text{X (a complex "C=..." is NOT a letter). */
export function extractBoxed(answer: string): { value?: number; unit?: string; letter?: string; raw: string } | undefined {
  let content: string | undefined;
  for (const m of answer.matchAll(BOXED_RE)) content = (m[1] ?? m[2])?.trim();
  if (content) {
    const hadText = /\\text\s*\{/.test(content);
    const unwrapped = content.replace(/\\text\s*\{([^}]*)\}/, "$1").trim();
    if (unwrapped) {
      // 只提取明确写出的常数，不计算等号右侧的表达式。
      const num = unwrapped.match(new RegExp("^(?:[A-Za-z]\\s*=\\s*)?(" + NUM + ")\\s*" + UNIT + "?$"));
      if (num) return { value: Number(num[1]), ...(num[2] ? { unit: num[2] } : {}), raw: unwrapped };
      if (/^[A-Za-z]$/.test(unwrapped)) return { letter: unwrapped.toUpperCase(), raw: unwrapped };
      if (hadText) {
        const lead = unwrapped.match(/^([A-Za-z])\b/); // \text{G. ...} -> G
        if (lead) return { letter: lead[1]!.toUpperCase(), raw: unwrapped };
      }
    }
  }
  // Fallback for deeply-nested boxed like \boxed{\text{G. } \frac{..}{..}}.
  const boxedTextLead = answer.match(/\\boxed\s*\{\s*\\text\s*\{\s*([A-Za-z])/);
  if (boxedTextLead) return { letter: boxedTextLead[1]!.toUpperCase(), raw: boxedTextLead[0] };
  return undefined;
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
const markdown = unified().use(remarkParse);

function markdownText(node: MarkdownNode): string {
  if (node.type === "text") return node.value ?? "";
  if (["paragraph", "heading", "strong", "emphasis", "link", "root"].includes(node.type)) return (node.children ?? []).map(markdownText).join("");
  return "";
}

// 只接受首尾段落中与公开选项全文一致的选项行；代码、引文和推理变量不作为提交。
function optionLines(answer: string, options: Record<string, string>): { label: string; evidence: string }[] {
  const tree = markdown.parse(answer) as unknown as MarkdownNode;
  const nodes = tree.children ?? [];
  const out: { label: string; evidence: string }[] = [];
  for (const node of [nodes[0], nodes.at(-1)]) {
    if (!node || !["paragraph", "heading"].includes(node.type)) continue;
    const line = markdownText(node).split(/\r?\n/)[0]?.trim() ?? "";
    const match = line.match(/^([A-Z])[.)、]\s+(.+)$/);
    if (!match) continue;
    const label = match[1]!, option = options[label];
    if (option === undefined) continue;
    const expected = markdownText(markdown.parse(option) as unknown as MarkdownNode).trim();
    if (match[2]!.trim() === expected) out.push({ label, evidence: line });
  }
  return out;
}

export function extractChoiceCandidates(answer: string, labels: string[], options?: Record<string, string>): { candidates: string[]; evidence: string[] } {
  const upper = new Set(labels.map((l) => l.toUpperCase()));
  // 1. FINAL declarations = text markers + boxed. Distinct: one -> the submission;
  //    several DIFFERENT -> genuine conflict (gradeSingleChoice -> pending).
  const finals: string[] = [];
  // Strip \boxed{...} first (handled by extractBoxed) so "correct choice: \boxed{X}"
  // doesn't let the text regex misfire on the "b" of "boxed".
  const textPart = answer.replace(/\\boxed\s*\{[^}]*\}/g, " ").replace(/\\boxed\s+[A-Za-z0-9.\-+]+/g, " ");
  for (const m of textPart.matchAll(TEXT_FINAL_CHOICE_RE)) {
    const L = m[1]!.toUpperCase();
    if (upper.has(L)) finals.push(L);
  }
  const boxed = extractBoxed(answer);
  if (boxed?.letter && upper.has(boxed.letter)) finals.push(boxed.letter);
  const distinct = [...new Set(finals)];
  if (distinct.length >= 1) {
    return { candidates: distinct, evidence: distinct.length === 1 ? [`final declaration -> ${distinct[0]}`] : [`conflicting finals: ${distinct.join(",")}`] };
  }
  // 2. No final declaration: fall back to incidental option mentions.
  const found: string[] = [];
  const evidence: string[] = [];
  for (const m of answer.matchAll(SELECTION_MARKERS)) {
    const letter = m[1]!.toUpperCase();
    if (upper.has(letter)) {
      found.push(letter);
      evidence.push(m[0].trim());
    }
  }
  for (const line of options ? optionLines(answer, options) : []) {
    found.push(line.label);
    evidence.push(line.evidence);
  }
  return { candidates: [...new Set(found)], evidence };
}

/** Distinct option letters appearing inside ANY \boxed{...} in the answer. */
function boxedLetters(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/\\boxed\s*\{([^}]*)\}/g)) {
    const boxed = extractBoxed(m[0]);
    if (boxed?.letter) out.push(boxed.letter);
  }
  return [...new Set(out)];
}
/** Offset where the final-answer region begins (last final marker or \boxed). */
function finalScopeStart(answer: string): number {
  let idx = -1;
  for (const m of answer.matchAll(TEXT_FINAL_CHOICE_RE)) if (m.index !== undefined) idx = Math.max(idx, m.index);
  for (const m of answer.matchAll(/\\boxed/g)) if (m.index !== undefined) idx = Math.max(idx, m.index);
  return idx < 0 ? 0 : idx;
}

// ---------------- numeric + unit ----------------
const NUM = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
const UNIT = "([A-Za-zµΩ°%][\\wµΩ°%·/^*•-]*)";
const STRONG_MARKERS = "(?:final\\s+answer|correct\\s+answer|answer|最终答案|最终结果|最终|答案是|答案为|答案|therefore|thus|hence)";
const STRONG_ANCHOR_RE = new RegExp(STRONG_MARKERS + "\\s*(?:是|为|is|are|was|equal|equals)?\\s*[：:=\\s]*(" + NUM + ")\\s*" + UNIT + "?", "gi");
const ANCHOR_RE = new RegExp("(?:result|因此|所以|得|解得|=|≈)\\s*(?:是|为|is|are|was|equal|equals)?\\s*[：:=\\s]*(" + NUM + ")\\s*" + UNIT + "?", "gi");
const UNCERTAINTY_RE = /无法确定|不能确定|不确定|无法得出|难以确定|不能肯定|无法肯定|未必|cannot determine|can'?t determine|unable to determine|not certain|not sure|indeterminate/i;
const DISJUNCTION_RE = /(?:[-+]?\d(?:\.\d+)?(?:\s*[A-Za-zµΩ°%][\wµΩ°%·/^*•-]*)?)\s*(?:或|或者|or)\s*(?:[-+]?\d(?:\.\d+)?)/i;

export interface NumericCandidate {
  value: number;
  unit: string;
  evidence: string;
  index: number;
  anchored: boolean;
}

export function extractNumericCandidates(answer: string): NumericCandidate[] {
  const strong: NumericCandidate[] = [];
  for (const match of answer.matchAll(BOXED_RE)) {
    const boxed = extractBoxed(match[0]);
    if (boxed?.value !== undefined) strong.push({ value: boxed.value, unit: boxed.unit ?? "", evidence: match[0], index: match.index ?? 0, anchored: true });
  }
  for (const m of answer.matchAll(STRONG_ANCHOR_RE)) {
    strong.push({ value: Number(m[1]), unit: (m[2] ?? "").trim(), evidence: m[0].trim(), index: m.index ?? 0, anchored: true });
  }
  if (strong.length > 0) return strong;

  const anchored: NumericCandidate[] = [];
  for (const m of answer.matchAll(ANCHOR_RE)) {
    anchored.push({ value: Number(m[1]), unit: (m[2] ?? "").trim(), evidence: m[0].trim(), index: m.index ?? 0, anchored: true });
  }
  if (anchored.length > 0) return anchored;
  const out: NumericCandidate[] = [];
  const numRe = new RegExp("(" + NUM + ")\\s*" + UNIT + "?", "g");
  for (const m of answer.matchAll(numRe)) {
    out.push({ value: Number(m[1]), unit: (m[2] ?? "").trim(), evidence: m[0].trim(), index: m.index ?? 0, anchored: false });
  }
  return out;
}

function parseReference(reference: string): { value: number | null; unit: string } {
  const m = reference.match(new RegExp(NUM));
  if (!m || m.index === undefined) return { value: null, unit: "" };
  const rest = reference.slice(m.index + m[0].length).trim();
  return { value: Number(m[0]), unit: rest.split(/\s+/)[0] ?? "" };
}

const SI_PREFIX: Record<string, number> = {
  da: 1e1, h: 1e2, k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  n: 1e-9, "µ": 1e-6, u: 1e-6, m: 1e-3, c: 1e-2, d: 1e-1,
};
const BASE_UNITS = new Set(["m", "g", "s", "A", "K", "mol", "cd", "N", "Pa", "J", "W", "C", "V", "F", "Ω", "Hz", "L", "bar", "eV", "m/s^2"]);

export function parseUnit(u: string): { base: string; scale: number } | null {
  if (!u) return null;
  if (BASE_UNITS.has(u)) return { base: u, scale: 1 };
  for (const p of Object.keys(SI_PREFIX)) {
    if (u.startsWith(p)) {
      const rest = u.slice(p.length);
      if (BASE_UNITS.has(rest)) return { base: rest, scale: SI_PREFIX[p]! };
    }
  }
  return null;
}

type UnitCmp = "ok" | "wrong" | "unknown_unit" | "missing_unit";

function compareValueUnit(ansValue: number, ansUnit: string, refValue: number, refUnit: string, accepted: string[], tol: number): UnitCmp {
  const target = refUnit || accepted[0] || "";
  if (!target) return Math.abs(ansValue - refValue) <= Math.max(tol, 1e-9) ? "ok" : "wrong";
  if (!ansUnit) {
    return Math.abs(ansValue - refValue) <= Math.max(tol, 1e-9) ? "missing_unit" : "wrong";
  }
  const a = parseUnit(ansUnit);
  const r = parseUnit(target);
  if (!a || !r) return "unknown_unit";
  if (a.base !== r.base) return "wrong";
  const converted = (ansValue * a.scale) / r.scale;
  return Math.abs(converted - refValue) <= Math.max(tol, 1e-9) ? "ok" : "wrong";
}

function result(partial: Omit<ObjectiveResult, "maxScore">, maxScore: number): ObjectiveResult {
  return { ...partial, maxScore };
}

export function gradeSingleChoice(q: PublicQuestion, s: ScoringSpec, answer: string): ObjectiveResult {
  const labels = Object.keys(q.options ?? {});
  const ref = typeof s.reference === "string" ? s.reference.trim().toUpperCase() : "";
  const max = s.maxScore;

  const { candidates, evidence } = extractChoiceCandidates(answer, labels, q.options);

  if (candidates.length === 0) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "no clear final selection found" }, max);
  }
  if (candidates.length > 1) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: `conflicting selections: ${candidates.join(",")}` }, max);
  }
  const chosen = candidates[0]!;

  // Single clear final declaration — judge uniqueness / parallelism / uncertainty
  // WITHIN the final-answer region only (P1-3).
  const scope = answer.slice(finalScopeStart(answer));
  // P1-2: STRUCTURAL uniqueness — tokenize the final declaration (marker text + the
  // rest of its sentence) and count SINGLE-letter option tokens. More than one
  // distinct valid option (A or B / A, B / A/B / A & B) is NOT a unique choice.
  // (Uniform — no per-connector string list, so novel separators are covered too.)
  const labelSet = new Set(labels.map((l) => l.toUpperCase()));
  let markerText = "";
  let markerEnd = -1;
  let firstLetter = "";
  for (const m of answer.matchAll(TEXT_FINAL_CHOICE_RE)) {
    if (labelSet.has(m[1]!.toUpperCase())) {
      markerText = m[0];
      markerEnd = (m.index ?? 0) + m[0].length;
      firstLetter = m[1]!.toUpperCase();
    }
  }
  if (markerEnd >= 0) {
    // Walk the option list right after the final marker: single-letter valid
    // options count; english connectors (or/and) are skipped; the first real WORD
    // (or a sentence terminator immediately after) ends the list. >1 distinct
    // option -> not a unique choice (covers A or B / A, B / A/B / A & B / A和B),
    // while a dismissed "Option B is wrong" in the next clause is NOT counted.
    const opts = new Set<string>([firstLetter]);
    const after = answer.slice(markerEnd);
    if (!/^\s*[.。!?;；\n]/.test(after)) {
      for (const tok of after.split(/[^A-Za-z]+/).filter(Boolean)) {
        if (tok.length === 1 && labelSet.has(tok.toUpperCase())) {
          opts.add(tok.toUpperCase());
          continue;
        }
        if (/^(or|and)$/i.test(tok)) continue;
        break;
      }
    }
    if (opts.size > 1) {
      return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: `final answer names multiple options: ${[...opts].sort().join(",")}` }, max);
    }
  }
  if (markerEnd < 0) {
    // No clear final marker: a bare option list / disjunction anywhere is ambiguous
    // (e.g. "选 B、C", "B/C"). Conservative -> pending (never a guessed full mark).
    const cls = [...labelSet].join("").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const alternatives = cls ? [...answer.matchAll(new RegExp(`(?<![A-Za-z0-9])([${cls}])(?![A-Za-z0-9])\\s*(?:或|或者|or\\b|and\\b|、|,|/|&|和)\\s*([${cls}])(?![A-Za-z0-9])`, "gi"))] : [];
    if (alternatives.some((match) => match[1]!.toUpperCase() !== match[2]!.toUpperCase())) {
      return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "disjunction / multiple options with no clear final selection" }, max);
    }
  }
  const boxes = boxedLetters(answer);
  if (boxes.length > 1) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: `multiple boxed options: ${boxes.join(",")}` }, max);
  }
  if (UNCERTAINTY_RE.test(scope)) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "final answer expresses uncertainty" }, max);
  }

  const alternatives = s.acceptableAlternatives.map((alternative) => alternative.trim().toUpperCase());
  const accepted = new Set([ref, ...alternatives.filter((alternative) => labelSet.has(alternative))]);
  const correct = accepted.has(chosen);
  if (!correct && alternatives.some((alternative) => !labelSet.has(alternative))) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "acceptable alternatives require interpretation beyond option labels" }, max);
  }
  return result(
    {
      judgement: correct ? "correct" : "incorrect",
      rawScore: correct ? max : 0,
      items: [{ points: correct ? max : 0, evidence: evidence.join(" | "), note: `chose ${chosen}, reference ${ref}${accepted.size > 1 ? `, accepted ${[...accepted].join(",")}` : ""}` }],
      reviewStatus: "rule_graded",
      evidence: evidence.join(" | "),
    },
    max,
  );
}

export function gradeNumericUnit(s: ScoringSpec, answer: string): ObjectiveResult {
  const ref = parseReference(typeof s.reference === "string" ? s.reference : "");
  const tol = s.tolerance ?? 0;
  const max = s.maxScore;

  if (ref.value === null) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "reference not numeric" }, max);
  }
  if (UNCERTAINTY_RE.test(answer)) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "answer expresses uncertainty" }, max);
  }
  if (DISJUNCTION_RE.test(answer)) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "disjunction / alternative values" }, max);
  }

  if ([...answer.matchAll(BOXED_RE)].some((match) => extractBoxed(match[0])?.value === undefined)) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "boxed numeric expression requires interpretation" }, max);
  }

  const candidates = extractNumericCandidates(answer);
  if (candidates.length === 0) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "no numeric answer found" }, max);
  }
  if (candidates.some((candidate) => !Number.isFinite(candidate.value))) {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: "numeric candidate is not finite" }, max);
  }

  const seen = new Map<string, NumericCandidate>();
  for (const c of candidates) {
    const key = `${c.value}|${c.unit}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  const distinct = [...seen.values()];
  if (distinct.length > 1) {
    return result(
      {
        judgement: "pending",
        rawScore: 0,
        items: [],
        reviewStatus: "pending_human_review",
        evidence: `conflicting candidates: ${distinct.map((c) => c.value + (c.unit ? " " + c.unit : "")).join(" / ")}`,
      },
      max,
    );
  }

  const fin = candidates[candidates.length - 1]!;
  const cmp = compareValueUnit(fin.value, fin.unit, ref.value, ref.unit, s.units, tol);
  if (cmp === "ok") {
    return result(
      { judgement: "correct", rawScore: max, items: [{ points: max, evidence: fin.evidence, note: `final ${fin.value}${fin.unit ? " " + fin.unit : ""} matches ${ref.value}${ref.unit ? " " + ref.unit : ""}` }], reviewStatus: "rule_graded", evidence: fin.evidence },
      max,
    );
  }
  if (cmp === "unknown_unit") {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: `unit '${fin.unit}' not recognized — not guessed` }, max);
  }
  if (cmp === "missing_unit") {
    return result({ judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: `value ${fin.value} matches but required unit not stated (expected ${ref.unit || s.units.join("/")})` }, max);
  }
  return result({ judgement: "incorrect", rawScore: 0, items: [{ points: 0, evidence: fin.evidence, note: `final ${fin.value}${fin.unit ? " " + fin.unit : ""} != ${ref.value}${ref.unit ? " " + ref.unit : ""}` }], reviewStatus: "rule_graded", evidence: fin.evidence }, max);
}

export function gradeNonDeterministic(s: ScoringSpec): ObjectiveResult {
  return result(
    { judgement: "pending", rawScore: 0, items: [], reviewStatus: "pending_human_review", evidence: `${s.answerKind} requires human/model review in v1` },
    s.maxScore,
  );
}

export function gradeObjective(q: PublicQuestion, s: ScoringSpec, answer: string): ObjectiveResult {
  switch (s.answerKind) {
    case "single_choice":
      return gradeSingleChoice(q, s, answer);
    case "numeric_unit":
      return gradeNumericUnit(s, answer);
    case "multi_choice":
    case "multi_blank":
    case "expression":
    case "open":
    case "out_of_scope":
      return gradeNonDeterministic(s);
  }
}
