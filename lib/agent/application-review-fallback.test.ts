import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { assessApplicationSource, assessApplicationSourceRound } from "./application-source-review";
import type {
  ApplicationReviewEvidence,
  ApplicationReviewContinuation,
} from "./application-source-review";
import { emptySourceReviewInvocation } from "./product-source-review-batches";
import type { ProductSourceReviewInput, SourceReviewPolicy } from "./product-source-review";

const input: ProductSourceReviewInput = {
  appSpec: "Save the record on the server.",
  appSpecDigest: "spec",
  clarifications: [],
  files: [],
  omissions: [],
  originalRequest: "Save the record on the server.",
  sourceDigest: "source",
};
const file = 'export const save = (x) => localStorage.setItem("x", x);';
const evidence: ApplicationReviewEvidence = {
  changedPaths: ["app/save.ts"],
  readRedactionTexts: async () => [input.originalRequest ?? "", input.appSpec],
  readRequirements: async () => ({ text: input.originalRequest ?? "" }),
  readSource: async () => ({
    content: file,
    digest: "a",
    endColumn: file.length + 1,
    endLine: 1,
    path: "app/save.ts",
    startColumn: 1,
    startLine: 1,
    totalLines: 1,
  }),
  requirements: [{ id: "original", kind: "original", order: 0 }],
  sourceFiles: [{ digest: "a", mode: "644", path: "app/save.ts" }],
  verifyRequirementQuote: async ({ quote }) => (input.originalRequest ?? "").includes(quote),
  verifySourceCitation: async ({ path, startLine, endLine, excerpt }) =>
    path === "app/save.ts" && startLine === 1 && endLine === 1 && excerpt === file,
};
const finding = {
  citations: [{ endLine: 1, excerpt: file, path: "app/save.ts", startLine: 1 }],
  explanation: "The save uses browser storage.",
  repair: "Save on the server.",
  requirement: "Server persistence",
  requirementDocumentId: "original",
  requirementQuote: "Save the record on the server.",
};
const policy: SourceReviewPolicy = {
  fallback: { modelId: "sol", reasoningEffort: null },
  id: "test-terra-sol",
  primary: { modelId: "terra", reasoningEffort: "low" },
};
type Step = Error | { name: string; input: unknown }[];
const model = (id: string, steps: Step[]) => {
  let index = 0;
  return new MockLanguageModelV4({
    async doGenerate() {
      await Promise.resolve();
      const step = steps[index];
      index += 1;
      if (step instanceof Error) {
        throw step;
      }
      if (step === undefined) {
        throw new Error("unexpected step");
      }
      return {
        content: step.map((x, i) => ({
          input: JSON.stringify(x.input),
          toolCallId: `${id}-${index}-${i}`,
          toolName: x.name,
          type: "tool-call" as const,
        })),
        finishReason: { raw: "tool_calls", unified: "tool-calls" as const },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
          outputTokens: { reasoning: 0, text: 5, total: 5 },
        },
        warnings: [],
      };
    },
    modelId: id,
  });
};
const record = [
  {
    input: { findings: [finding], remainingRuntimeChecks: ["Verify persistence."] },
    name: "recordReviewEvidence",
  },
];
const complete = [{ input: { remainingRuntimeChecks: [] }, name: "completeReview" }];
const reads = [
  { input: { id: "original" }, name: "readRequirements" },
  { input: { path: "app/save.ts" }, name: "readSource" },
];

describe("durable application reviewer fallback", () => {
  it("starts fallback with fresh messages and independent evidence", async () => {
    const primary = model("terra", [record, new Error("temporary provider failure")]);
    const fallback = model("sol", [reads, complete]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({
      modelId: "terra",
      reasoningEffort: "low",
      reviewCompleted: false,
      reviewPolicyId: "test-terra-sol",
      status: "failed",
    });
    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(fallback.doGenerateCalls).toHaveLength(2);
    expect(primary.doGenerateCalls[0].providerOptions?.openai).toMatchObject({
      reasoningEffort: "low",
    });
    expect(fallback.doGenerateCalls[0].providerOptions?.openai).toBeUndefined();
    expect(result.invocation?.requestAttempts).toBe(4);
    expect(result.invocation?.successfulRequests).toBe(3);
    expect(
      fallback.doGenerateCalls[0].prompt.filter((message) => message.role !== "system"),
    ).toHaveLength(1);
  });
  it("does not credit primary references or findings to fallback completion", async () => {
    const primary = model("terra", [record, new Error("first")]);
    const fallback = model("sol", [complete, new Error("second")]);
    const options = { policy, testModels: { sol: fallback, terra: primary } };
    let round = await assessApplicationSourceRound(input, evidence, options);
    while (round.assessment === undefined) {
      // Each round depends on the preceding durable continuation.
      // eslint-disable-next-line no-await-in-loop
      round = await assessApplicationSourceRound(input, evidence, options, round.continuation);
    }
    expect(round.assessment).toMatchObject({
      modelId: "terra",
      reviewCompleted: false,
      status: "failed",
    });
    expect(round.assessment?.findings).toHaveLength(1);
    expect(round.continuation.priorReviewerEvidence?.reviewer.modelId).toBe("terra");
    expect(round.continuation.priorReviewerEvidence?.findings).toHaveLength(1);
    expect(round.continuation.references).toHaveLength(0);
  });
  it("attributes findings from both reviewers as incomplete mixed evidence", async () => {
    const primary = model("terra", [record, new Error("first")]);
    const otherFinding = {
      ...finding,
      explanation: "A second independent finding.",
      requirementQuote: "Save the record",
    };
    const fallback = model("sol", [
      [
        {
          input: { findings: [otherFinding], remainingRuntimeChecks: [] },
          name: "recordReviewEvidence",
        },
      ],
      complete,
    ]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({ modelId: "multiple", reviewCompleted: false, status: "failed" });
    expect(result.findings).toHaveLength(2);
    expect(result.evidenceNote).toContain("terra and sol");
  });
  it("preserves primary runtime unknowns when fallback omits them", async () => {
    const primary = model("terra", [
      [
        {
          input: { findings: [], remainingRuntimeChecks: ["Verify server persistence."] },
          name: "recordReviewEvidence",
        },
      ],
      new Error("first"),
    ]);
    const fallback = model("sol", [complete]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({ modelId: "sol", reviewCompleted: true });
    expect(result.remainingRuntimeChecks).toContain("Verify server persistence.");
    expect(result.evidenceNote).toContain("from terra");
  });
  it("reports checks-only evidence as blocked if fallback fails", async () => {
    const primary = model("terra", [
      [
        {
          input: { findings: [], remainingRuntimeChecks: ["Verify server persistence."] },
          name: "recordReviewEvidence",
        },
      ],
      new Error("first"),
    ]);
    const fallback = model("sol", [new Error("second")]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({ modelId: "terra", reviewCompleted: false, status: "blocked" });
    expect(result.remainingRuntimeChecks).toContain("Verify server persistence.");
  });
  it("preserves prior findings when fallback evidence access fails", async () => {
    const primary = model("terra", [record, new Error("first")]);
    const fallback = model("sol", [[{ input: { path: "app/save.ts" }, name: "readSource" }]]);
    const failedEvidence = {
      ...evidence,
      readSource: async () => {
        throw new Error("unavailable");
      },
    };
    const result = await assessApplicationSource(input, failedEvidence, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({ modelId: "terra", reviewCompleted: false, status: "failed" });
    expect(result.findings).toHaveLength(1);
  });
  it("does not fall back after completed primary review", async () => {
    const primary = model("terra", [complete]);
    const fallback = model("sol", [complete]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({
      modelId: "terra",
      reasoningEffort: "low",
      reviewCompleted: true,
    });
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
  it("reports unavailable when both reviewers fail", async () => {
    const primary = model("terra", [new Error("first")]);
    const fallback = model("sol", [new Error("second")]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({ modelId: "sol", reviewCompleted: false, status: "blocked" });
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });
  it("keeps primary findings separate if fallback also fails", async () => {
    const primary = model("terra", [record, new Error("first")]);
    const fallback = model("sol", [new Error("second")]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({
      modelId: "terra",
      reviewCompleted: false,
      status: "failed",
    });
    expect(result.reason).toContain("unavailable");
    expect(JSON.stringify(result)).not.toContain(file);
  });
  it("never falls back after cancellation", async () => {
    const controller = new AbortController();
    const primary = model("terra", [new Error("first")]);
    const fallback = model("sol", [complete]);
    const guard = vi.fn(async () => {
      await Promise.resolve();
      if (primary.doGenerateCalls.length > 0) {
        controller.abort();
      }
    });
    await expect(
      assessApplicationSource(input, evidence, {
        abortSignal: controller.signal,
        assertCurrentOwner: guard,
        policy,
        testModels: { sol: fallback, terra: primary },
      }),
    ).rejects.toThrow();
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
  it("never falls back after evidence becomes unavailable", async () => {
    const primary = model("terra", [[{ input: { path: "app/save.ts" }, name: "readSource" }]]);
    const fallback = model("sol", [complete]);
    const inaccessible: ApplicationReviewEvidence = {
      ...evidence,
      readSource: async () => {
        throw new Error("unavailable");
      },
    };
    const result = await assessApplicationSource(input, inaccessible, {
      policy,
      testModels: { sol: fallback, terra: primary },
    });
    expect(result).toMatchObject({ reviewCompleted: false, status: "blocked" });
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
  it("never falls back when ownership is revoked", async () => {
    const primary = model("terra", [new Error("first")]);
    const fallback = model("sol", [complete]);
    const guard = vi.fn(async () => {
      await Promise.resolve();
      if (primary.doGenerateCalls.length > 0) {
        throw new Error("owner revoked");
      }
    });
    await expect(
      assessApplicationSource(input, evidence, {
        assertCurrentOwner: guard,
        policy,
        testModels: { sol: fallback, terra: primary },
      }),
    ).rejects.toThrow("owner revoked");
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
  it("preserves Sol identity for pre-policy continuation", async () => {
    const old: ApplicationReviewContinuation = {
      completionRequested: false,
      evidenceFailed: false,
      findings: [],
      invalidEvidence: false,
      invocation: emptySourceReviewInvocation(),
      messages: [{ content: "legacy", role: "user" }],
      outputRejected: false,
      references: [],
      requestOrdinal: 0,
      reusableReads: [],
      runtimeChecks: [],
      stepNumber: 0,
      version: 1,
    };
    const primary = model("terra", [complete]);
    const fallback = model("openai/gpt-6.1-sol", [complete]);
    const result = await assessApplicationSourceRound(
      input,
      evidence,
      { policy, testModels: { "openai/gpt-6.1-sol": fallback, terra: primary } },
      old,
    );
    expect(result.assessment).toMatchObject({
      modelId: "openai/gpt-6.1-sol",
      reviewCompleted: true,
      reviewPolicyId: "legacy-sol",
    });
    expect(primary.doGenerateCalls).toHaveLength(0);
  });
});
