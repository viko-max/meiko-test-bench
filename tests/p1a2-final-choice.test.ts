import { describe, it, expect } from "vitest";
import { gradeObjective } from "../src/grading/objective.js";
import { PublicQuestionSchema, ScoringSpecSchema } from "../src/shared/contracts.js";

// options A..J (supergpqa style)
const opts: Record<string, string> = {};
for (const c of "ABCDEFGHIJ") opts[c] = `option ${c}`;
const q = PublicQuestionSchema.parse({ id: "q", version: "1", subject: "m", answerKind: "single_choice", stem: "pick", options: opts, assets: [] });
const spec = (reference: string) => ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 1, reference, deterministicLocked: true });

describe("P1-A2 a clear FINAL answer wins over incidental option mentions in reasoning", () => {
  it("'Answer: **G**' (bold) with incidental letters in reasoning -> grades G", () => {
    const ans = "## Setting up ... At x = A/sqrt2 ... ## Answer: **G** ## Check: option A is wrong";
    expect(gradeObjective(q, spec("G"), ans).judgement).toBe("correct");
    expect(gradeObjective(q, spec("A"), ans).judgement).toBe("incorrect");
  });

  it("'**Answer: A**' with an option table mentioning J in reasoning -> grades A", () => {
    const ans = "## Answer: A. Reduce elasticity **Reasoning:** ... | J. Remain unchanged | free volume decreases |";
    expect(gradeObjective(q, spec("A"), ans).judgement).toBe("correct");
    expect(gradeObjective(q, spec("J"), ans).judgement).toBe("incorrect");
  });

  it("'\\boxed{\\text{F}}' (text wrapper) -> grades F", () => {
    const ans = "Computing ... so the correct choice is: \\boxed{\\text{F}}";
    expect(gradeObjective(q, spec("F"), ans).judgement).toBe("correct");
  });

  it("'\\boxed{C=...}' in reasoning then '**Answer: D**' final -> grades D", () => {
    const ans = "So \\boxed{C=\\frac{4}{15}-\\frac{19}{30}i} ... **Answer: D**";
    expect(gradeObjective(q, spec("D"), ans).judgement).toBe("correct");
  });

  it("no final choice at all (only reasoning) -> pending (not guessed)", () => {
    const ans = "We compute the two branches: ... giving mu = -mu_B ... (no explicit choice)";
    expect(gradeObjective(q, spec("G"), ans).judgement).toBe("pending");
  });

  it("explicit uncertainty still -> pending", () => {
    expect(gradeObjective(q, spec("G"), "The answer is G, but I am not certain").judgement).toBe("pending");
  });
});
