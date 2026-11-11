import { describe, it, expect } from "vitest";
import { ScoringSpecSchema } from "../src/shared/contracts.js";
import { gradeNumericUnit } from "../src/grading/objective.js";

const spec = (reference: string, units: string[]) =>
  ScoringSpecSchema.parse({
    questionId: "q",
    questionVersion: "1",
    scoringVersion: "1",
    answerKind: "numeric_unit",
    maxScore: 5,
    reference,
    tolerance: 0.01,
    units,
    deterministicLocked: true,
  });

describe("R1-2 unit: case-sensitive + supported conversion + unknown→pending", () => {
  it("MPa ≠ mPa (case-sensitive prefixes)", () => {
    const s = spec("1 MPa", ["MPa"]);
    expect(gradeNumericUnit(s, "结果为 1 mPa").judgement).toBe("incorrect"); // 1e-3 Pa ≠ 1e6 Pa
    expect(gradeNumericUnit(s, "结果为 1 MPa").judgement).toBe("correct");
  });

  it("equivalent units are converted before comparison", () => {
    expect(gradeNumericUnit(spec("1 m", ["m"]), "因此为 1000 mm").judgement).toBe("correct");
    expect(gradeNumericUnit(spec("1 m", ["m"]), "0.001 km").judgement).toBe("correct");
    expect(gradeNumericUnit(spec("1 MPa", ["MPa"]), "1000 kPa").judgement).toBe("correct"); // 1e6 Pa
    expect(gradeNumericUnit(spec("1 kN", ["kN"]), "1000 N").judgement).toBe("correct");
    expect(gradeNumericUnit(spec("1 kN", ["kN"]), "1 N").judgement).toBe("incorrect"); // scale mismatch
  });

  it("unknown/unsupported unit is NOT guessed -> pending", () => {
    const r = gradeNumericUnit(spec("6 N", ["N"]), "答案是 6 frobnicates");
    expect(r.judgement).toBe("pending");
    expect(r.reviewStatus).toBe("pending_human_review");
  });
});
