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
  originalRequest: "Save the record on the server.",
  appSpec: "Save the record on the server.",
  appSpecDigest: "spec",
  sourceDigest: "source",
  clarifications: [],
  omissions: [],
  files: [],
};
const file = 'export const save = (x) => localStorage.setItem("x", x);';
const evidence: ApplicationReviewEvidence = {
  requirements: [{ id: "original", kind: "original", order: 0 }],
  sourceFiles: [{ path: "app/save.ts", digest: "a", mode: "644" }],
  changedPaths: ["app/save.ts"],
  readRedactionTexts: () => Promise.resolve([input.originalRequest ?? "", input.appSpec]),
  readRequirements: () => Promise.resolve({ text: input.originalRequest ?? "" }),
  readSource: () =>
    Promise.resolve({
      path: "app/save.ts",
      digest: "a",
      content: file,
      startLine: 1,
      endLine: 1,
      startColumn: 1,
      endColumn: file.length + 1,
      totalLines: 1,
    }),
  verifyRequirementQuote: ({ quote }) =>
    Promise.resolve((input.originalRequest ?? "").includes(quote)),
  verifySourceCitation: ({ path, startLine, endLine, excerpt }) =>
    Promise.resolve(path === "app/save.ts" && startLine === 1 && endLine === 1 && excerpt === file),
};
const finding = {
  requirementDocumentId: "original",
  requirement: "Server persistence",
  requirementQuote: "Save the record on the server.",
  explanation: "The save uses browser storage.",
  repair: "Save on the server.",
  citations: [{ path: "app/save.ts", startLine: 1, endLine: 1, excerpt: file }],
};
const policy: SourceReviewPolicy = {
  id: "test-terra-sol",
  primary: { modelId: "terra", reasoningEffort: "low" },
  fallback: { modelId: "sol", reasoningEffort: null },
};
type Step = Error | { name: string; input: unknown }[];
const model = (id: string, steps: Step[]) => {
  let index = 0;
  return new MockLanguageModelV4({
    modelId: id,
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
          type: "tool-call" as const,
          toolCallId: `${id}-${index}-${i}`,
          toolName: x.name,
          input: JSON.stringify(x.input),
        })),
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
};
const record = [
  {
    name: "recordReviewEvidence",
    input: { findings: [finding], remainingRuntimeChecks: ["Verify persistence."] },
  },
];
const complete = [{ name: "completeReview", input: { remainingRuntimeChecks: [] } }];
const reads = [
  { name: "readRequirements", input: { id: "original" } },
  { name: "readSource", input: { path: "app/save.ts" } },
];

describe("durable application reviewer fallback", () => {
  it("starts fallback with fresh messages and independent evidence", async () => {
    const primary = model("terra", [record, new Error("temporary provider failure")]);
    const fallback = model("sol", [reads, complete]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { terra: primary, sol: fallback },
    });
    expect(result).toMatchObject({
      reviewCompleted: false,
      status: "failed",
      modelId: "terra",
      reasoningEffort: "low",
      reviewPolicyId: "test-terra-sol",
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
    const options = { policy, testModels: { terra: primary, sol: fallback } };
    let round = await assessApplicationSourceRound(input, evidence, options);
    while (round.assessment === undefined) {
      // Each round depends on the preceding durable continuation.
      // eslint-disable-next-line no-await-in-loop
      round = await assessApplicationSourceRound(input, evidence, options, round.continuation);
    }
    expect(round.assessment).toMatchObject({
      reviewCompleted: false,
      status: "failed",
      modelId: "terra",
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
      requirementQuote: "Save the record",
      explanation: "A second independent finding.",
    };
    const fallback = model("sol", [
      [
        {
          name: "recordReviewEvidence",
          input: { findings: [otherFinding], remainingRuntimeChecks: [] },
        },
      ],
      complete,
    ]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { terra: primary, sol: fallback },
    });
    expect(result).toMatchObject({ reviewCompleted: false, status: "failed", modelId: "multiple" });
    expect(result.findings).toHaveLength(2);
    expect(result.evidenceNote).toContain("terra and sol");
  });
  it("preserves primary runtime unknowns when fallback omits them", async () => {
    const primary = model("terra", [
      [
        {
          name: "recordReviewEvidence",
          input: { findings: [], remainingRuntimeChecks: ["Verify server persistence."] },
        },
      ],
      new Error("first"),
    ]);
    const fallback = model("sol", [complete]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { terra: primary, sol: fallback },
    });
    expect(result).toMatchObject({ reviewCompleted: true, modelId: "sol" });
    expect(result.remainingRuntimeChecks).toContain("Verify server persistence.");
    expect(result.evidenceNote).toContain("from terra");
  });
  it("reports checks-only evidence as blocked if fallback fails", async () => {
    const primary = model("terra", [
      [
        {
          name: "recordReviewEvidence",
          input: { findings: [], remainingRuntimeChecks: ["Verify server persistence."] },
        },
      ],
      new Error("first"),
    ]);
    const fallback = model("sol", [new Error("second")]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { terra: primary, sol: fallback },
    });
    expect(result).toMatchObject({ reviewCompleted: false, status: "blocked", modelId: "terra" });
    expect(result.remainingRuntimeChecks).toContain("Verify server persistence.");
  });
  it("preserves prior findings when fallback evidence access fails", async () => {
    const primary = model("terra", [record, new Error("first")]);
    const fallback = model("sol", [[{ name: "readSource", input: { path: "app/save.ts" } }]]);
    const failedEvidence = {
      ...evidence,
      readSource: () => Promise.reject(new Error("unavailable")),
    };
    const result = await assessApplicationSource(input, failedEvidence, {
      policy,
      testModels: { terra: primary, sol: fallback },
    });
    expect(result).toMatchObject({ reviewCompleted: false, status: "failed", modelId: "terra" });
    expect(result.findings).toHaveLength(1);
  });
  it("does not fall back after completed primary review", async () => {
    const primary = model("terra", [complete]);
    const fallback = model("sol", [complete]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { terra: primary, sol: fallback },
    });
    expect(result).toMatchObject({
      reviewCompleted: true,
      modelId: "terra",
      reasoningEffort: "low",
    });
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
  it("reports unavailable when both reviewers fail", async () => {
    const primary = model("terra", [new Error("first")]);
    const fallback = model("sol", [new Error("second")]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { terra: primary, sol: fallback },
    });
    expect(result).toMatchObject({ reviewCompleted: false, status: "blocked", modelId: "sol" });
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });
  it("keeps primary findings separate if fallback also fails", async () => {
    const primary = model("terra", [record, new Error("first")]);
    const fallback = model("sol", [new Error("second")]);
    const result = await assessApplicationSource(input, evidence, {
      policy,
      testModels: { terra: primary, sol: fallback },
    });
    expect(result).toMatchObject({
      reviewCompleted: false,
      status: "failed",
      modelId: "terra",
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
        policy,
        abortSignal: controller.signal,
        assertCurrentOwner: guard,
        testModels: { terra: primary, sol: fallback },
      }),
    ).rejects.toThrow();
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
  it("never falls back after evidence becomes unavailable", async () => {
    const primary = model("terra", [[{ name: "readSource", input: { path: "app/save.ts" } }]]);
    const fallback = model("sol", [complete]);
    const inaccessible: ApplicationReviewEvidence = {
      ...evidence,
      readSource: () => Promise.reject(new Error("unavailable")),
    };
    const result = await assessApplicationSource(input, inaccessible, {
      policy,
      testModels: { terra: primary, sol: fallback },
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
        policy,
        assertCurrentOwner: guard,
        testModels: { terra: primary, sol: fallback },
      }),
    ).rejects.toThrow("owner revoked");
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
  it("preserves Sol identity for pre-policy continuation", async () => {
    const old: ApplicationReviewContinuation = {
      version: 1,
      messages: [{ role: "user", content: "legacy" }],
      findings: [],
      runtimeChecks: [],
      references: [],
      reusableReads: [],
      completionRequested: false,
      invalidEvidence: false,
      evidenceFailed: false,
      outputRejected: false,
      invocation: emptySourceReviewInvocation(),
      requestOrdinal: 0,
      stepNumber: 0,
    };
    const primary = model("terra", [complete]);
    const fallback = model("openai/gpt-6.1-sol", [complete]);
    const result = await assessApplicationSourceRound(
      input,
      evidence,
      { policy, testModels: { terra: primary, "openai/gpt-6.1-sol": fallback } },
      old,
    );
    expect(result.assessment).toMatchObject({
      modelId: "openai/gpt-6.1-sol",
      reviewPolicyId: "legacy-sol",
      reviewCompleted: true,
    });
    expect(primary.doGenerateCalls).toHaveLength(0);
  });
});
