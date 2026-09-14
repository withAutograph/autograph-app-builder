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
                explanation: "secret source",
                citations: [
                  {
                    path: "secret-file.ts",
                    startLine: 1,
                    endLine: 3,
                    excerptDigest: "b".repeat(64),
                  },
                ],
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
    expect(decodeOwnerGraph([{ a: 1, b: 1 }, { value: 2 }, "retained"])).toEqual({
      a: { value: "retained" },
      b: { value: "retained" },
    });
    expect(decodeOwnerGraph([["Class", 1], "payload"])).toBeUndefined();
  });
});
