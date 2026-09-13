import { describe, expect, it } from "vitest";
import { referenceNavigationObservation } from "./self-reproduction-reference-navigation";

const titles = [
  "/auth/sign-in?callbackURL=%2F streams its meaningful production shell and resolves",
  "real Sign In Link uses a prefetched production destination",
];
const report = (statuses: string[]) => ({
    suites: [
      {
        file: "navigation.spec.ts",
        specs: titles.map((title, index) => ({
          tests: [{ results: [{ status: statuses[index] }] }],
          title,
        })),
      },
    ],
});
describe("reference navigation evidence", () => {
  it("credits exact direct and Link tests with resolved controls", () => {
    const result = referenceNavigationObservation({
      artifacts: ["run.json"],
      report: report(["passed", "passed"]),
    });
    expect(result.method).toBe("@next/playwright/instant");
    expect(result.assertions).toHaveLength(3);
    expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
  });
  it("retains an actual assertion failure without treating it as missing infrastructure", () => {
    const result = referenceNavigationObservation({
      artifacts: ["run.json"],
      report: report(["passed", "failed"]),
    });
    expect(result.disposition).toBe("observed");
    expect(result.assertions.map(({ passed }) => passed)).toEqual([true, false, false]);
  });
  it("does not credit aggregate passes, skipped cases, or similarly named unrelated tests", () => {
    expect(referenceNavigationObservation({ artifacts: [], report: {} }).disposition).toBe(
      "not-run",
    );
    expect(
      referenceNavigationObservation({ artifacts: [], report: report(["passed", "skipped"]) })
        .assertions,
    ).toEqual([]);
    const unrelated = report(["passed", "passed"]);
    const [suite] = unrelated.suites;
    if (!suite) throw new Error("Expected a navigation suite.");
    suite.file = "unrelated.spec.ts";
    expect(referenceNavigationObservation({ artifacts: [], report: unrelated }).disposition).toBe(
      "not-run",
    );
  });
});
