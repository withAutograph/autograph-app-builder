import {
  unavailableSourceAssessment,
  validateSourceJudgment,
} from "../lib/agent/product-source-review";
import { describe, expect, it } from "vitest";
import { decodeOwnerGraph, observeSourceReviews } from "./source-review-observation";

describe("private owner source review observation", () => {
  it("retains only allowlisted review evidence and write counts", () => {
    const report = observeSourceReviews("original secret brief", [
      {
        output: {
          previewUrl: "https://secret.invalid/token",
          sourceAssessment: {
            evidenceDigest: "a".repeat(64),
            findings: [
              {
                citations: [
                  {
                    endLine: 3,
                    excerptDigest: "b".repeat(64),
                    path: "secret-file.ts",
                    startLine: 1,
                  },
                ],
                explanation: "secret source",
              },
            ],
            modelId: "openai/gpt-6-astra",
            reviewCompleted: true,
            status: "failed",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
          status: "reviewed",
        },
        toolCallId: "secret-call",
        toolName: "accept_change_set",
      },
      {
        input: { implementationFiles: [{ content: "secret source" }] },
        output: { status: "validated" },
        toolName: "validate_app_creation",
      },
    ]);
    expect(report.status).toBe("observed");
    expect(report.rows[1].implementationWriteCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret");
  });
  it("keeps absent review and missing input unassessed", () => {
    expect(
      observeSourceReviews("brief", [
        { output: { status: "reviewed" }, toolName: "accept_change_set" },
      ]).status,
    ).toBe("unassessed");
    expect(observeSourceReviews(undefined, []).status).toBe("unassessed");
  });
  it("resolves references without executing tagged classes and handles shared references", () => {
    expect(decodeOwnerGraph(JSON.stringify([{ a: 1, b: 1 }, { value: 2 }, "retained"]))).toEqual({
      a: { value: "retained" },
      b: { value: "retained" },
    });
    expect(decodeOwnerGraph(JSON.stringify([["Class", 1], "payload"]))).toBeNull();
  });
});

it("pairs separate input and JSON result fragments without conflating later calls", () => {
  const report = observeSourceReviews("brief", [
    {
      input: { implementationFiles: [{ content: "private" }] },
      toolCallId: "one",
      toolName: "validate_app_creation",
    },
    {
      output: { type: "json", value: { status: "validated" } },
      toolCallId: "one",
      toolName: "validate_app_creation",
    },
    {
      output: { type: "json", value: { status: "failed" } },
      toolCallId: "two",
      toolName: "validate_app_creation",
    },
  ]);
  expect(report.rows).toHaveLength(2);
  expect(report.rows[0]).toMatchObject({ implementationWriteCount: 1, status: "validated" });
  expect(report.rows[1].status).toBe("failed");
});

it("retains actual shared producer clean, blocked and failed source judgments", () => {
  const input = {
    appSpec: "Build real persistence",
    appSpecDigest: "a".repeat(64),
    clarifications: [],
    files: [{ content: "localStorage.setItem('draft', value)", path: "app/page.tsx" }],
    omissions: [],
    originalRequest: "Build real persistence",
    sourceDigest: "b".repeat(64),
  };
  const clean = validateSourceJudgment(input, { findings: [], remainingRuntimeChecks: [] });
  const blocked = unavailableSourceAssessment(input, "private failure", "blocked");
  const failed = validateSourceJudgment(input, {
    findings: [
      {
        citations: [
          {
            endLine: 1,
            excerpt: "localStorage.setItem('draft', value)",
            path: "app/page.tsx",
            startLine: 1,
          },
        ],
        explanation: "Only browser writes",
        repair: "Write durable data",
        requirement: "Persistence",
        requirementQuote: "Build real persistence",
      },
    ],
    remainingRuntimeChecks: [],
  });
  const report = observeSourceReviews(
    input.originalRequest,
    [clean, blocked, failed].map((sourceAssessment, index) => ({
      output: { sourceAssessment },
      toolCallId: String(index),
      toolName: "accept_change_set",
    })),
  );
  expect(report.rows.map((row) => row.sourceAssessment?.status)).toEqual([
    "unassessed",
    "blocked",
    "failed",
  ]);
  expect(report.rows[0].sourceAssessment?.reviewCompleted).toBe(true);
  expect(report.rows[2].sourceAssessment?.findings[0].requirementQuoteDigest).toBe(
    failed.findings[0].requirementQuoteDigest,
  );
  expect(report.rows[1].sourceAssessment?.reviewCompleted).toBe(false);
  expect(report.rows[2].sourceAssessment?.findings[0].citations[0]).toMatchObject({
    endLine: 1,
    startLine: 1,
  });
  expect(JSON.stringify(report)).not.toContain("private failure");
});

it("supports devalue's undefined root sentinel", () => {
  expect(decodeOwnerGraph("-1")).toBeNull();
});
