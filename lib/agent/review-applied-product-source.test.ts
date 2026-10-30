/* oxlint-disable eslint/require-await -- Faithful asynchronous observation and judge test doubles. */
import { expect, it, vi } from "vitest";
import {
  currentChangedSourcePaths,
  completedReviewForInput,
  reviewObservedProductSource,
  reviewApplicationWithJournal,
  sourceReviewScopeBindingDigest,
} from "./review-applied-product-source";
import { sourceReviewPolicy, unavailableSourceAssessment } from "./product-source-review";
import {
  applicationReviewVisibility,
  createApplicationReviewEvidence,
} from "./application-review-evidence";
import { createHash } from "node:crypto";
import type { SourceReviewJournalRecord } from "./product-source-review-journal";
import {
  applicationSourceReviewRubricDigest,
  ApplicationReviewSelectionError,
} from "./application-source-review";
import type {
  ApplicationReviewEvidence,
  ApplicationSourceReviewOptions,
} from "./application-source-review";
import type { ProductSourceReviewInput } from "./product-source-review";

const reviewInput = {
  appSpec: "Accepted plan",
  appSpecDigest: "spec",
  clarifications: ["Use durable drafts"],
  files: [],
  omissions: [],
  originalRequest: "Original full request",
  sourceDigest: "before",
};
const observe = async () => ({
  currentDigest: async () => "observed",
  source: { files: [], omissions: ["No behavior inferred"], sourceDigest: "observed" },
});
it("reviews every current normalized path, including repairs and supporting source", () => {
  const changes = [
    { kind: "modified" as const, path: "apps/example/page.tsx" },
    { kind: "added" as const, path: "apps/example/error.tsx" },
    { kind: "modified" as const, path: ".config/app-specs/example.cue" },
    { kind: "added" as const, path: "apps/example/schema/release/v2/manifest.json" },
    { kind: "modified" as const, path: "packages/shared/runtime.ts" },
    { kind: "deleted" as const, path: "apps/example/demo.tsx" },
  ];
  expect(currentChangedSourcePaths(changes)).toEqual([
    "apps/example/page.tsx",
    "apps/example/error.tsx",
    ".config/app-specs/example.cue",
    "apps/example/schema/release/v2/manifest.json",
    "packages/shared/runtime.ts",
  ]);
});
it("keeps aggregate cache bindings distinct when review scope changes on the same source tree", () => {
  const first = [{ kind: "added" as const, path: "apps/example/page.tsx" }];
  const expanded = [...first, { kind: "added" as const, path: "apps/example/error.tsx" }];
  expect(sourceReviewScopeBindingDigest(reviewInput, first)).toBe(
    sourceReviewScopeBindingDigest(reviewInput, [...first]),
  );
  expect(sourceReviewScopeBindingDigest(reviewInput, first)).not.toBe(
    sourceReviewScopeBindingDigest(reviewInput, expanded),
  );
});
it("binds original requirements and actual source to the shared cached reviewer", async () => {
  const review = vi.fn(async () => unavailableSourceAssessment(reviewInput, "test"));
  await reviewObservedProductSource({ mockModel: false, observe, reviewInput }, review);
  expect(review).toHaveBeenCalledWith(
    expect.objectContaining({
      appSpec: "Accepted plan",
      clarifications: ["Use durable drafts"],
      originalRequest: "Original full request",
      sourceDigest: "observed",
    }),
    false,
    expect.any(Function),
    undefined,
    undefined,
  );
});
it("retains unavailable source as blocked without invoking the judge", async () => {
  const review = vi.fn(async () => unavailableSourceAssessment(reviewInput, "test"));
  const result = await reviewObservedProductSource(
    {
      mockModel: false,
      observe: async () => {
        throw new Error("read failed");
      },
      reviewInput,
    },
    review,
  );
  expect(result).toMatchObject({ reviewCompleted: false, status: "blocked" });
  expect(review).not.toHaveBeenCalled();
});
it("does not substitute an accepted plan for missing original request", async () => {
  const review = vi.fn(async () => unavailableSourceAssessment(reviewInput, "test"));
  const result = await reviewObservedProductSource(
    { mockModel: false, observe, reviewInput: { ...reviewInput, originalRequest: null } },
    review,
  );
  expect(result.status).toBe("unassessed");
  expect(review).not.toHaveBeenCalled();
});
it("propagates cancellation rather than returning an unavailable assessment", async () => {
  const controller = new AbortController();
  const observed = async () => {
    controller.abort(new Error("cancelled"));
    throw new Error("read cancelled");
  };
  await expect(
    reviewObservedProductSource({
      abortSignal: controller.signal,
      mockModel: false,
      observe: observed,
      reviewInput,
    }),
  ).rejects.toThrow("cancelled");
});

const exactDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const sourceEvidence = (
  files: Record<string, string>,
  options?: {
    appSpecParts?: () => AsyncIterable<string>;
    abortSignal?: AbortSignal;
    digestOverride?: string;
  },
) =>
  createApplicationReviewEvidence({
    reviewInput,
    applyRoot: "/workspace/repository",
    observed: {
      files: Object.entries(files).map(([path, content]) => ({
        path,
        digest: options?.digestOverride ?? exactDigest(content),
        mode: "644",
      })),
      treeDigest: reviewInput.sourceDigest,
    },
    changedPaths: ["apps/example/page.ts"],
    visiblePaths: Object.keys(files),
    sandbox: {
      readFile: async ({ path }: { path: string }) => {
        const content = files[path.replace(/^repository\//u, "")];
        return content === undefined ? null : new Blob([content]).stream();
      },
    },
    appSpecParts: options?.appSpecParts,
    abortSignal: options?.abortSignal,
  });
it("keeps original requirements, chronological product changes and complete durable AppSpec readable once", async () => {
  let opened = 0;
  const fullSpec = "Complete accepted AppSpec. ".repeat(900);
  const evidence = sourceEvidence(
    {},
    {
      appSpecParts: async function* appSpecParts() {
        opened += 1;
        yield fullSpec.slice(0, 100);
        yield fullSpec.slice(100);
      },
    },
  );
  expect(evidence.requirements.map(({ kind }) => kind)).toEqual([
    "original",
    "clarification",
    "app-spec",
  ]);
  expect(await evidence.readRequirements({ id: "original" })).toEqual({
    text: "Original full request",
  });
  expect(await evidence.readRequirements({ id: "clarification-0" })).toEqual({
    text: "Use durable drafts",
  });
  const first = await evidence.readRequirements({ id: "app-spec" });
  const second = await evidence.readRequirements({ id: "app-spec", cursor: first.nextCursor });
  expect(first.text + second.text).toBe(fullSpec);
  expect(
    await evidence.verifyRequirementQuote({ documentId: "app-spec", quote: fullSpec.slice(-100) }),
  ).toBe(true);
  expect(await evidence.readRedactionTexts()).toEqual([
    "Original full request",
    "Use durable drafts",
    fullSpec,
  ]);
  expect(opened).toBe(1);
});
it("reads exact ranged evidence from relevant unchanged imports and rejects invented evidence", async () => {
  const evidence = sourceEvidence({
    "apps/example/page.ts": 'import { save } from "../../shared/save";',
    "packages/shared/save.ts":
      "export async function save() {\n  return database.insert(record);\n}",
    "secrets.json": '{"credential":"must-not-read"}',
  });
  const source = await evidence.readSource({
    path: "packages/shared/save.ts",
    startLine: 2,
    endLine: 2,
  });
  expect(source.content).toBe("  return database.insert(record);");
  expect(source.startLine).toBe(2);
  expect(
    await evidence.verifySourceCitation({
      path: source.path,
      startLine: 2,
      endLine: 2,
      excerpt: source.content,
    }),
  ).toBe(true);
  expect(
    await evidence.verifySourceCitation({
      path: source.path,
      startLine: 2,
      endLine: 2,
      excerpt: "invented",
    }),
  ).toBe(false);
  expect(await evidence.verifyRequirementQuote({ documentId: "original", quote: "invented" })).toBe(
    false,
  );
  expect(evidence.sourceFiles.map(({ path }) => path)).not.toContain("secrets.json");
  await expect(evidence.readSource({ path: "secrets.json" })).rejects.toThrow(
    "not available review source",
  );
  await expect(evidence.readSource({ path: "../outside.ts" })).rejects.toThrow(
    "not available review source",
  );
});
it("verifies complete file bytes before returning a requested range", async () => {
  const evidence = sourceEvidence(
    { "apps/example/page.ts": "changed bytes" },
    { digestOverride: exactDigest("observed bytes") },
  );
  await expect(
    evidence.readSource({ path: "apps/example/page.ts", startLine: 1, endLine: 1 }),
  ).rejects.toThrow("changed since");
});
const completedApplication = () => ({
  ...unavailableSourceAssessment(
    reviewInput,
    "Independent source review cannot prove runtime behavior",
    "unassessed",
    sourceReviewPolicy().primary,
  ),
  reviewPolicyId: sourceReviewPolicy().id,
  reviewRubricDigest: applicationSourceReviewRubricDigest(),
  reviewCompleted: true,
  status: "unassessed" as const,
});
it("authorizes application journal reuse before returning completed evidence without another generation", async () => {
  const assessment = completedApplication();
  const read = vi.fn(async () => ({ kind: "application-completed" as const, assessment }));
  const put = vi.fn(async (_key: string, record: SourceReviewJournalRecord) => record);
  const assess = vi.fn(async () => assessment);
  const input = {
    reviewInput,
    normalizedChanges: [],
    evidence: sourceEvidence({}),
    journal: { assertCurrentOwner: async () => {}, read, put },
    currentDigest: async () => reviewInput.sourceDigest,
  };
  const result = await reviewApplicationWithJournal(input, assess);
  expect(read).toHaveBeenCalledOnce();
  expect(assess).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    reviewCompleted: true,
    status: "unassessed",
    invocation: { requestAttempts: 0, journalReuses: 1 },
  });
  read.mockRejectedValueOnce(new Error("owner revoked"));
  await expect(reviewApplicationWithJournal(input, assess)).rejects.toThrow("owner revoked");
  expect(assess).not.toHaveBeenCalled();
});
it("strips fresh invocation from durable completion", async () => {
  const assessment = {
    ...completedApplication(),
    invocation: {
      requestAttempts: 1,
      successfulRequests: 1,
      journalReuses: 0,
      splits: 0,
      requestsWithIncompleteUsage: 0,
      freshUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    },
  };
  const read = vi.fn(async (): Promise<undefined> => {});
  const put = vi.fn(async (_key: string, record: SourceReviewJournalRecord) => record);
  const assess = vi.fn(async () => assessment);
  const result = await reviewApplicationWithJournal(
    {
      reviewInput,
      normalizedChanges: [],
      evidence: sourceEvidence({}),
      journal: { assertCurrentOwner: async () => {}, read, put },
      currentDigest: async () => reviewInput.sourceDigest,
    },
    assess,
  );
  expect(assess).toHaveBeenCalledOnce();
  expect(put).toHaveBeenCalledWith(expect.any(String), {
    kind: "application-completed",
    assessment: completedApplication(),
  });
  expect(result.invocation?.freshUsage.totalTokens).toBe(12);
});
it("keeps repeated evidence authorization separate from the one completed-assessment lookup", async () => {
  const read = vi.fn(async (): Promise<undefined> => undefined);
  const assertCurrentOwner = vi.fn(async () => {});
  const put = vi.fn(async (_key: string, record: SourceReviewJournalRecord) => record);
  const result = await reviewApplicationWithJournal(
    {
      reviewInput,
      normalizedChanges: [],
      evidence: sourceEvidence({}),
      journal: { assertCurrentOwner, read, put },
      currentDigest: async () => reviewInput.sourceDigest,
    },
    async (_input, _evidence, options) => {
      await options?.assertCurrentOwner?.();
      await options?.assertCurrentOwner?.();
      await options?.assertCurrentOwner?.();
      return completedApplication();
    },
  );
  expect(result.reviewCompleted).toBe(true);
  expect(read).toHaveBeenCalledOnce();
  expect(assertCurrentOwner).toHaveBeenCalledTimes(3);
  expect(put).toHaveBeenCalledOnce();
});
it("does not publish completed application evidence after source changes or Stop", async () => {
  const controller = new AbortController();
  const put = vi.fn(async (_key: string, record: SourceReviewJournalRecord) => record);
  const common = {
    reviewInput,
    normalizedChanges: [],
    evidence: sourceEvidence({}),
    journal: {
      assertCurrentOwner: async () => {},
      read: async (): Promise<undefined> => {
        /* No completed record exists in this fixture. */
      },
      put,
    },
  };
  const assess = vi.fn(async () => completedApplication());
  const stale = await reviewApplicationWithJournal(
    { ...common, currentDigest: async () => "new source" },
    assess,
  );
  expect(stale.reviewCompleted).toBe(false);
  expect(put).not.toHaveBeenCalled();
  await expect(
    reviewApplicationWithJournal(
      {
        ...common,
        currentDigest: async () => reviewInput.sourceDigest,
        options: { abortSignal: controller.signal },
      },
      async () => {
        controller.abort(new Error("Stop"));
        return completedApplication();
      },
    ),
  ).rejects.toThrow("Stop");
  expect(put).not.toHaveBeenCalled();
});
it("releases a pending source byte read when Stop arrives", async () => {
  const controller = new AbortController();
  const reading = Promise.withResolvers<boolean>();
  const cancel = vi.fn();
  const evidence = createApplicationReviewEvidence({
    reviewInput,
    applyRoot: "/workspace/repository",
    changedPaths: ["apps/example/page.ts"],
    visiblePaths: ["apps/example/page.ts"],
    observed: {
      files: [{ path: "apps/example/page.ts", digest: exactDigest("pending"), mode: "644" }],
      treeDigest: reviewInput.sourceDigest,
    },
    abortSignal: controller.signal,
    sandbox: {
      readFile: async () =>
        new ReadableStream<Uint8Array>(
          {
            pull() {
              reading.resolve(true);
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
    },
  });
  const result = evidence.readSource({ path: "apps/example/page.ts" });
  await reading.promise;
  controller.abort(new Error("Stop source read"));
  await expect(result).rejects.toThrow("Stop source read");
  expect(cancel).toHaveBeenCalledOnce();
});

it("preserves validated baseline visibility and narrows missing optional metadata without a setup gate", () => {
  const input = {
    observedPaths: ["app/page.ts", "shared/save.ts", "retained/later/manifest.json"],
    changedPaths: ["app/page.ts"],
    hasSelectedBaseline: true,
  };
  const fallback = applicationReviewVisibility(input);
  expect(fallback.paths).toEqual(["app/page.ts"]);
  expect(fallback.omissions).toHaveLength(1);
  expect(
    applicationReviewVisibility({ ...input, unexposedReleasePrefixes: ["retained/later/"] }),
  ).toEqual({ paths: ["app/page.ts", "shared/save.ts"], omissions: [] });
  expect(applicationReviewVisibility({ ...input, hasSelectedBaseline: false }).paths).toEqual(
    input.observedPaths,
  );
});

it("distinguishes correctable evidence selection from actual observed source failures", async () => {
  const evidence = sourceEvidence({ "apps/example/page.ts": "observed source" });
  await expect(evidence.readSource({ path: "packages/guessed-import.ts" })).rejects.toBeInstanceOf(
    ApplicationReviewSelectionError,
  );
  await expect(
    evidence.readSource({ path: "apps/example/page.ts", startLine: 5 }),
  ).rejects.toBeInstanceOf(ApplicationReviewSelectionError);
  await expect(evidence.readRequirements({ id: "unknown-document" })).rejects.toBeInstanceOf(
    ApplicationReviewSelectionError,
  );
  await expect(evidence.readRequirements({ id: "original", cursor: 1000 })).rejects.toBeInstanceOf(
    ApplicationReviewSelectionError,
  );
  const observedSource = await evidence.readSource({ path: "apps/example/page.ts" });
  expect(observedSource.content).toBe("observed source");
  const changed = sourceEvidence(
    { "apps/example/page.ts": "new bytes" },
    { digestOverride: exactDigest("observed source") },
  );
  const actualFailure = changed.readSource({ path: "apps/example/page.ts" });
  await expect(actualFailure).rejects.toThrow("changed since");
  await expect(actualFailure).rejects.not.toBeInstanceOf(ApplicationReviewSelectionError);
});

it("rechecks fresh ownership without rereading completed evidence and blocks completion after revocation", async () => {
  let ownerAllowed = true;
  const read = vi.fn(async (_key: string): Promise<undefined> => undefined);
  const assertCurrentOwner = vi.fn(async () => {
    if (!ownerAllowed) {
      throw new Error("owner revoked during review");
    }
  });
  const put = vi.fn(async (_key: string, record: SourceReviewJournalRecord) => record);
  const assess = async (
    _input: ProductSourceReviewInput,
    _evidence: ApplicationReviewEvidence,
    options?: ApplicationSourceReviewOptions,
  ) => {
    await options?.assertCurrentOwner?.();
    ownerAllowed = false;
    await options?.assertCurrentOwner?.();
    return completedApplication();
  };
  await expect(
    reviewApplicationWithJournal(
      {
        reviewInput,
        normalizedChanges: [],
        evidence: sourceEvidence({}),
        journal: { assertCurrentOwner, read, put },
        currentDigest: async () => reviewInput.sourceDigest,
      },
      assess,
    ),
  ).rejects.toThrow("owner revoked during review");
  expect(read).toHaveBeenCalledOnce();
  expect(assertCurrentOwner).toHaveBeenCalledTimes(2);
  expect(put).not.toHaveBeenCalled();
});

it("rejects completed journal assessments with wrong policy, reviewer, effort, rubric, or binding", () => {
  const valid = completedApplication();
  expect(
    completedReviewForInput({ kind: "application-completed", assessment: valid }, reviewInput),
  ).toBe(true);
  for (const assessment of [
    { ...valid, reviewPolicyId: "wrong-policy" },
    { ...valid, modelId: "other-model" },
    { ...valid, reasoningEffort: "medium" as const },
    { ...valid, reviewRubricDigest: "a".repeat(64) },
    { ...valid, bindingDigest: "b".repeat(64) },
    { ...valid, reviewCompleted: false },
  ]) {
    expect(
      completedReviewForInput({ kind: "application-completed", assessment }, reviewInput),
    ).toBe(false);
  }
});

it("does not reuse an incompatible first-writer record or perform a fresh review against its occupied key", async () => {
  const valid = completedApplication();
  for (const assessment of [
    { ...valid, reviewPolicyId: "wrong-policy" },
    { ...valid, modelId: "other-model" },
    { ...valid, reasoningEffort: "medium" as const },
    { ...valid, reviewRubricDigest: "a".repeat(64) },
  ]) {
    const assess = vi.fn(async () => valid);
    const put = vi.fn();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Check each first-writer mismatch independently.
    const result = await reviewApplicationWithJournal(
      {
        reviewInput,
        normalizedChanges: [],
        evidence: sourceEvidence({}),
        journal: {
          assertCurrentOwner: async () => {},
          read: async () => ({ kind: "application-completed" as const, assessment }),
          put,
        },
        currentDigest: async () => reviewInput.sourceDigest,
      },
      assess,
    );
    expect(result).toMatchObject({ reviewCompleted: false, status: "blocked" });
    expect(assess).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  }
});

it("rejects an incompatible canonical first writer returned by journal put", async () => {
  const valid = completedApplication();
  for (const assessment of [
    { ...valid, reviewPolicyId: "wrong-policy" },
    { ...valid, modelId: "other-model" },
    { ...valid, reasoningEffort: "medium" as const },
    { ...valid, reviewRubricDigest: "a".repeat(64) },
  ]) {
    const read = vi.fn(async (): Promise<undefined> => {});
    const put = vi.fn(async () => ({ kind: "application-completed" as const, assessment }));
    // oxlint-disable-next-line eslint/no-await-in-loop -- Exercise each canonical mismatch independently.
    await expect(
      reviewApplicationWithJournal(
        {
          reviewInput,
          normalizedChanges: [],
          evidence: sourceEvidence({}),
          journal: { assertCurrentOwner: async () => {}, read, put },
          currentDigest: async () => reviewInput.sourceDigest,
        },
        async () => valid,
      ),
    ).rejects.toThrow("current policy");
    expect(put).toHaveBeenCalledOnce();
  }
});

it("does not publish an incompatible newly completed assessment", async () => {
  const invalid = { ...completedApplication(), reviewPolicyId: "wrong-policy" };
  const put = vi.fn();
  const result = await reviewApplicationWithJournal(
    {
      reviewInput,
      normalizedChanges: [],
      evidence: sourceEvidence({}),
      journal: {
        assertCurrentOwner: async () => {},
        read: async (): Promise<undefined> => {},
        put,
      },
      currentDigest: async () => reviewInput.sourceDigest,
    },
    async () => invalid,
  );
  expect(result).toMatchObject({ reviewCompleted: false, status: "blocked" });
  expect(put).not.toHaveBeenCalled();
});

it("fails closed on occupied non-application records without attempting a review or write", async () => {
  const assessment = completedApplication();
  const occupied: SourceReviewJournalRecord[] = [
    { kind: "completed", assessment },
    { kind: "split-source" },
    { kind: "split-context" },
  ];
  for (const record of occupied) {
    const assess = vi.fn(async () => assessment);
    const put = vi.fn();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Check each distinct occupied record independently.
    const result = await reviewApplicationWithJournal(
      {
        reviewInput,
        normalizedChanges: [],
        evidence: sourceEvidence({}),
        journal: { assertCurrentOwner: async () => {}, read: async () => record, put },
        currentDigest: async () => reviewInput.sourceDigest,
      },
      assess,
    );
    expect(result).toMatchObject({ reviewCompleted: false, status: "blocked" });
    expect(assess).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  }
});
