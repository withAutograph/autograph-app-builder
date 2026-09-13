import { describe, expect, it } from "vitest";
import { axes, judgeDesign, validateJudgment } from "./judge";

const image = {
  height: 100,
  name: "desktop-0",
  path: "unused.png",
  width: 100,
};
const valid = {
  findings: [
    {
      explanation: "Tight spacing",
      image: "desktop-0",
      improvement: "Increase row spacing",
      region: { height: 20, width: 20, x: 0, y: 0 },
      severity: "low",
    },
  ],
  limitations: ["Fixture content"],
  ratings: Object.fromEntries(
    axes.map((a) => [a, { reason: "Clear visible hierarchy", score: 3 }]),
  ),
  strengths: ["Readable labels"],
};
describe("design judgment", () => {
  it("computes advisory scores from anchored axes", () => {
    expect(validateJudgment(valid, [image]).subjectiveScore).toBe(75);
  });
  it("rejects invented screenshot coordinates", () => {
    expect(() =>
      validateJudgment(
        {
          ...valid,
          findings: [
            {
              ...valid.findings[0],
              region: { height: 20, width: 20, x: 90, y: 0 },
            },
          ],
        },
        [image],
      ),
    ).toThrow();
  });
  it("retains an incomplete state without credentials", async () => {
    const r = await judgeDesign(
      { brief: "test", evidence: {}, images: [image] },
      {
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        generate: async () => valid,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        getToken: async () => {
          throw new Error("secret-token");
        },
      },
    );
    expect(r.status).toBe("incomplete");
    expect(JSON.stringify(r)).not.toContain("secret-token");
    expect(r).not.toHaveProperty("subjectiveScore");
  });
  it("does not fabricate a score from invalid judge output", async () => {
    const r = await judgeDesign(
      { brief: "test", evidence: {}, images: [image] },
      {
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        generate: async () => ({ ratings: {} }),
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        getToken: async () => "mock-oidc",
      },
    );
    expect(r.status).toBe("incomplete");
    expect(r).not.toHaveProperty("subjectiveScore");
  });
  it("returns mocked validated scores without a provider", async () => {
    const r = await judgeDesign(
      { brief: "test", evidence: {}, images: [image] },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      { generate: async () => valid, getToken: async () => "mock-oidc" },
    );
    expect(r.status).toBe("complete");
    expect(r).toHaveProperty("subjectiveScore", 75);
  });
});
