import { describe, it, expect } from "vitest";
import { gradeObjective } from "../src/grading/objective.js";
import { PublicQuestionSchema, ScoringSpecSchema } from "../src/shared/contracts.js";

// options A..J (supergpqa style)
const opts: Record<string, string> = {};
for (const c of "ABCDEFGHIJ") opts[c] = `option ${c}`;
const q = PublicQuestionSchema.parse({ id: "q", version: "1", subject: "m", answerKind: "single_choice", stem: "pick", options: opts, assets: [] });
const spec = (reference: string) => ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 1, reference, deterministicLocked: true });

describe("P1-3 choice uniqueness / parallelism / uncertainty within the final-answer region", () => {
  it("'Answer: a or b' (lowercase disjunction), ref A -> pending (NOT a false full mark)", () => {
    expect(gradeObjective(q, spec("A"), "Answer: a or b").judgement).toBe("pending");
  });

  it("'Answer: A and B' (parallel options), ref A -> pending", () => {
    expect(gradeObjective(q, spec("A"), "Answer: A and B").judgement).toBe("pending");
  });

  it("'\\boxed{A} ... \\boxed{B}' (multiple boxed), ref B -> pending (genuine conflict)", () => {
    expect(gradeObjective(q, spec("B"), "Working through it ... \\boxed{A} ... on reflection \\boxed{B}").judgement).toBe("pending");
  });

  it("'Earlier I was not sure. Final answer: B' -> grades B (earlier uncertainty does not block a clear final)", () => {
    expect(gradeObjective(q, spec("B"), "Earlier I was not sure. Final answer: B").judgement).toBe("correct");
    expect(gradeObjective(q, spec("A"), "Earlier I was not sure. Final answer: B").judgement).toBe("incorrect");
  });

  // guards: no regression of the good behaviour
  it("a clear unique final still grades", () => {
    expect(gradeObjective(q, spec("A"), "The answer is A.").judgement).toBe("correct");
  });

  it("uncertainty INSIDE the final region still -> pending", () => {
    expect(gradeObjective(q, spec("A"), "The answer is A, but I am not certain").judgement).toBe("pending");
  });

  it("an incidental 'before' in reasoning is NOT a disjunction", () => {
    expect(gradeObjective(q, spec("A"), "Consider the setup before solving. The answer is A.").judgement).toBe("correct");
  });

  // P1-2: structural uniqueness — any connector / none, via single-letter option tokens.
  it("'Answer: A OR B' (uppercase), ref A -> pending", () => {
    expect(gradeObjective(q, spec("A"), "Answer: A OR B").judgement).toBe("pending");
  });
  it("'Answer: A, B' (comma), ref A -> pending", () => {
    expect(gradeObjective(q, spec("A"), "Answer: A, B").judgement).toBe("pending");
  });
  it("'Answer: A/B' (slash), ref A -> pending", () => {
    expect(gradeObjective(q, spec("A"), "Answer: A/B").judgement).toBe("pending");
  });
  it("'Answer: A & B' (ampersand), ref A -> pending", () => {
    expect(gradeObjective(q, spec("A"), "Answer: A & B").judgement).toBe("pending");
  });
  it("'Answer: A和B' (CJK), ref A -> pending", () => {
    expect(gradeObjective(q, spec("A"), "Answer: A和B").judgement).toBe("pending");
  });
  it("guard: 'Answer: B is correct' -> grades B (the word 'correct' is not an option)", () => {
    expect(gradeObjective(q, spec("B"), "Answer: B is correct").judgement).toBe("correct");
  });
  it("guard: 'The answer is A. Option B is wrong' -> grades A (dismissed B is the next sentence)", () => {
    expect(gradeObjective(q, spec("A"), "The answer is A. Option B is wrong.").judgement).toBe("correct");
  });
});
