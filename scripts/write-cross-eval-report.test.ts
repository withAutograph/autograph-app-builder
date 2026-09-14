import { expect, it } from "vitest";
import { buildCrossEvalReport, renderCrossEvalReport } from "./write-cross-eval-report.mts";

const inventory = [
  { execution: "deterministic", group: "general-enabled", id: "failed-journal-recovery" },
  { id: "missing" },
  { id: "errored" },
];
it("preserves missing and errored evidence without inventing infrastructure blockers", () => {
  const result = buildCrossEvalReport({
    baseline: {
      rows: [
        {
          current: { assessmentStatus: "failed", runnerOutcome: "failed" },
          name: "failed-journal-recovery",
        },
      ],
    },
    inventory,
    revision: "abc",
    summaries: [
      {
        evals: [
          {
            assertions: [{ passed: true, severity: "gate" }],
            id: "failed-journal-recovery",
            verdict: "passed",
          },
          { error: "secret transcript", id: "errored", verdict: "errored" },
        ],
        target: { url: "https://private/?token=secret" },
      },
    ],
  });
  expect(result.rows.map((row) => row.assessment.status)).toEqual([
    "passed",
    "unassessed",
    "unassessed",
  ]);
  expect(result.rows[0]?.transition).toBe("failed → passed");
  expect(result.improvements[0]?.preservation).toBe("confirmed by runner");
  expect(JSON.stringify(result)).not.toContain("secret");
});
it("retains failed attempts and keeps supplemental assessment separate from runner results", () => {
  const result = buildCrossEvalReport({
    baseline: {},
    inventory,
    revision: "abc",
    summaries: [
      {
        evals: [
          { assertions: [{ passed: false, severity: "gate" }], id: "errored", verdict: "failed" },
        ],
      },
    ],
    supplemental: {
      scenarios: [
        {
          evidence: ["receipt.json"],
          id: "errored",
          reason: "Observed infrastructure failure https://private?token=secret Bearer abc",
          status: "blocked",
        },
      ],
    },
  });
  expect(result.rows[2]?.runner?.verdict).toBe("failed");
  expect(result.rows[2]?.assessment.status).toBe("blocked");
  expect(renderCrossEvalReport(result).html).not.toContain("https://private");
  expect(renderCrossEvalReport(result).markdown).not.toContain("Bearer abc");
});
it("does not upgrade zero-assertion passes or unsubstantiated supplemental claims", () => {
  expect(
    buildCrossEvalReport({
      baseline: {},
      inventory,
      revision: "abc",
      summaries: [{ evals: [{ id: "missing", verdict: "passed" }] }],
    }).rows[1]?.assessment.status,
  ).toBe("unassessed");
  expect(() =>
    buildCrossEvalReport({
      baseline: {},
      inventory,
      revision: "abc",
      summaries: [],
      supplemental: { scenarios: [{ id: "missing", reason: "works", status: "passed" }] },
    }),
  ).toThrow("evidence");
});

it("retains incomplete summary coverage without dropping other completed attempts", () => {
  const result = buildCrossEvalReport({
    baseline: {},
    inventory,
    revision: "abc",
    summaries: [
      null,
      {
        evals: [
          {
            assertions: [{ passed: true, severity: "gate" }],
            id: "failed-journal-recovery",
            verdict: "passed",
          },
        ],
      },
    ],
  });
  expect(result.inputIssues).toHaveLength(1);
  expect(result.coverage.observed).toBe(1);
  expect(result.coverage.missing).toBe(2);
});
