import { describe, expect, it } from "vitest";
import { axes, judgeDesign, validateJudgment } from "./judge";
const image = {
  name: "desktop-0",
  path: "unused.png",
  width: 100,
  height: 100,
};
const valid = {
  ratings: Object.fromEntries(
    axes.map((a) => [a, { score: 3, reason: "Clear visible hierarchy" }]),
  ),
  strengths: ["Readable labels"],
  findings: [
    {
      image: "desktop-0",
      region: { x: 0, y: 0, width: 20, height: 20 },
      severity: "low",
      explanation: "Tight spacing",
      improvement: "Increase row spacing",
    },
  ],
  limitations: ["Fixture content"],
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
              region: { x: 90, y: 0, width: 20, height: 20 },
            },
          ],
        },
        [image],
      ),
    ).toThrow();
  });
  it("retains an incomplete state without credentials", async () => {
    const r = await judgeDesign(
      { brief: "test", images: [image], evidence: {} },
      {
        getToken: async () => {
          throw new Error("secret-token");
        },
        generate: async () => valid,
      },
    );
    expect(r.status).toBe("incomplete");
    expect(JSON.stringify(r)).not.toContain("secret-token");
    expect(r).not.toHaveProperty("subjectiveScore");
  });
  it("does not fabricate a score from invalid judge output", async () => {
    const r = await judgeDesign(
      { brief: "test", images: [image], evidence: {} },
      {
        getToken: async () => "mock-oidc",
        generate: async () => ({ ratings: {} }),
      },
    );
    expect(r.status).toBe("incomplete");
    expect(r).not.toHaveProperty("subjectiveScore");
  });
  it("returns mocked validated scores without a provider", async () => {
    const r = await judgeDesign(
      { brief: "test", images: [image], evidence: {} },
      { getToken: async () => "mock-oidc", generate: async () => valid },
    );
    expect(r.status).toBe("complete");
    expect(r).toHaveProperty("subjectiveScore", 75);
  });
});
