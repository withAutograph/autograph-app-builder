import { describe, expect, it } from "vitest";
import { referenceNavigationObservation } from "./self-reproduction-reference-navigation";

const titles = [
  "/auth/sign-in?callbackURL=%2F streams its meaningful production shell and resolves",
  "real Sign In Link uses a prefetched production destination",
];
function report(statuses: string[]) {
  return {
    suites: [
      {
        file: "navigation.spec.ts",
        specs: titles.map((title, index) => ({
          title,
          tests: [{ results: [{ status: statuses[index] }] }],
        })),
      },
    ],
  };
}
describe("reference navigation evidence", () => {
  it("credits exact direct and Link tests with resolved controls", () => {
    const result = referenceNavigationObservation({
      report: report(["passed", "passed"]),
      artifacts: ["run.json"],
    });
    expect(result.method).toBe("@next/playwright/instant");
    expect(result.assertions).toHaveLength(3);
    expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
  });
  it("retains an actual assertion failure without treating it as missing infrastructure", () => {
    const result = referenceNavigationObservation({
      report: report(["passed", "failed"]),
      artifacts: ["run.json"],
    });
    expect(result.disposition).toBe("observed");
    expect(result.assertions.map(({ passed }) => passed)).toEqual([true, false, false]);
  });
  it("does not credit aggregate passes, skipped cases, or similarly named unrelated tests", () => {
    expect(referenceNavigationObservation({ report: {}, artifacts: [] }).disposition).toBe(
      "not-run",
    );
    expect(
      referenceNavigationObservation({ report: report(["passed", "skipped"]), artifacts: [] })
        .assertions,
    ).toEqual([]);
    const unrelated = report(["passed", "passed"]);
    unrelated.suites[0]!.file = "unrelated.spec.ts";
    expect(referenceNavigationObservation({ report: unrelated, artifacts: [] }).disposition).toBe(
      "not-run",
    );
  });
});
