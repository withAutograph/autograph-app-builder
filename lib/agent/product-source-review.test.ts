import { describe, expect, it, vi } from "vitest";
import {
  assessProductSource,
  sourceReviewEvidenceDigest,
  validateSourceJudgment,
} from "./product-source-review";
import type { ProductSourceReviewInput } from "./product-source-review";

const input: ProductSourceReviewInput = {
  appSpec: "Build a draft screen.",
  appSpecDigest: "spec",
  clarifications: [],
  files: [
    {
      content: 'export function save(draft) { localStorage.setItem("draft", draft); }',
      path: "apps/example/actions.ts",
    },
  ],
  omissions: ["Shared dependencies not inspected"],
  originalRequest: "Save drafts on the server and recover after reload.",
  sourceDigest: "source",
};
const judgment = {
  findings: [
    {
      citations: [
        {
          endLine: 1,
          excerpt: input.files[0]?.content ?? "",
          path: "apps/example/actions.ts",
          startLine: 1,
        },
      ],
      explanation:
        "The save action only writes browser storage instead of executing the requested server write.",
      repair: "Implement an authenticated server write and readback for the save action.",
      requirement: "Server draft persistence",
      requirementQuote: "Save drafts on the server",
    },
  ],
  remainingRuntimeChecks: ["Execute save, reload, and independent server readback."],
};
describe("independent product source review", () => {
  it("retains original requirements omitted from a narrower specification and validates citations", async () => {
    const result = await assessProductSource(input, {
      generate: () => judgment,
    });
    expect(result.status).toBe("failed");
    expect(result.reviewCompleted).toBe(true);
    expect(result.findings[0]?.repair).toContain("server write");
    expect(JSON.stringify(result)).not.toContain(input.originalRequest);
    expect(JSON.stringify(result)).not.toContain(input.files[0]?.content);
    expect(result.omissions).toEqual(input.omissions);
  });
  it("never grants runtime success or bans localStorage when no contradiction is established", () => {
    const result = validateSourceJudgment(input, {
      findings: [],
      remainingRuntimeChecks: ["Verify the actual backend."],
    });
    expect(result.status).toBe("unassessed");
    expect(result.reviewCompleted).toBe(true);
    expect(result.findings).toEqual([]);
  });
  it("does not confirm invented paths, altered excerpts, or invented requirements", () => {
    for (const finding of [
      {
        ...judgment.findings[0],
        citations: [{ ...judgment.findings[0]?.citations[0], path: "missing.ts" }],
      },
      {
        ...judgment.findings[0],
        citations: [{ ...judgment.findings[0]?.citations[0], excerpt: "invented" }],
      },
      { ...judgment.findings[0], requirementQuote: "Support blockchain" },
    ]) {
      expect(validateSourceJudgment(input, { ...judgment, findings: [finding] })).toMatchObject({
        findings: [],
        reviewCompleted: false,
        status: "unassessed",
      });
    }
  });
  it("keeps mock profiles credential-free and refuses to substitute the specification for a missing original", async () => {
    const generate = vi.fn(() => judgment);
    expect(await assessProductSource(input, { generate, mockModel: true })).toMatchObject({
      reviewCompleted: false,
      status: "unassessed",
    });
    expect(
      await assessProductSource({ ...input, originalRequest: null }, { generate }),
    ).toMatchObject({ reviewCompleted: false, status: "unassessed" });
    expect(generate).not.toHaveBeenCalled();
  });
  it("retains unavailable review without exposing provider errors", async () => {
    const result = await assessProductSource(input, {
      generate: () => {
        throw new Error("Bearer secret");
      },
    });
    expect(result.status).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain("Bearer secret");
  });
  it("binds findings to actual source bytes and user clarifications", () => {
    const digest = sourceReviewEvidenceDigest(input);
    expect(
      sourceReviewEvidenceDigest({
        ...input,
        clarifications: ["Browser-only storage is sufficient now."],
      }),
    ).not.toBe(digest);
    expect(
      sourceReviewEvidenceDigest({
        ...input,
        files: [{ content: "serverWrite()", path: "apps/example/actions.ts" }],
      }),
    ).not.toBe(digest);
  });
  it("does not echo original user messages, source excerpts, or common credentials in findings", () => {
    const result = validateSourceJudgment(input, {
      ...judgment,
      findings: judgment.findings.map((finding) => ({
        ...finding,
        explanation: `${input.originalRequest} Bearer private-token`,
      })),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain(input.originalRequest);
    expect(serialized).not.toContain(input.files[0]?.content);
    expect(result.status).toBe("failed");
  });
});
