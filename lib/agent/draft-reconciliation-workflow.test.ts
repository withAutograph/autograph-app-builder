/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- Eve tool context and sandbox are isolated to verify the actual publication gate. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion -- Deliberately minimal Eve state and tool context stubs for this publication gate test. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import editCandidate from "../../agent/tools/edit_github_draft_pr_candidate";
import sealReconciliation from "../../agent/tools/seal_github_draft_pr_reconciliation";
import { DraftCandidateCreationUncertainError } from "../repository/sandbox-draft-reconciliation";
import type { draftSchemaReleaseId } from "../repository/sandbox-draft-schema-release";
import type { assertExactWorkflowState } from "./workflow-state";
import {
  draftReconciliationCompletions,
  retainDraftReconciliationCompletion,
} from "./draft-reconciliation-state";

const digest = "a".repeat(64);
const sha = "b".repeat(40);
const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  states: new Map<string, unknown>(),
  inspect: vi.fn(),
  create: vi.fn(),
  discardSchema: vi.fn(),
  inspectOwnedDraft: vi.fn(),
  readOwnedDraft: vi.fn(),
  read: vi.fn(),
  replace: vi.fn(),
  restore: vi.fn(),
  seal: vi.fn(),
  workflow: null as Record<string, unknown> | null,
}));

vi.mock("eve/tools", () => ({ defineTool: <T>(value: T): T => value }));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: () => ({
    inspectExistingDraftReconciliationSource: mocks.inspectOwnedDraft,
    readSucceededDraftPublication: mocks.readOwnedDraft,
    sealExistingDraftReconciliation: mocks.seal,
  }),
}));
vi.mock("eve/context", () => ({
  defineState: (name: string, initial: () => unknown) => ({
    get: () =>
      name === "autograph-app-builder.draft-reconciliation.v1"
        ? mocks.candidate
        : (mocks.states.get(name) ?? initial()),
    update: (transition: (current: unknown) => unknown) => {
      if (name === "autograph-app-builder.draft-reconciliation.v1") {
        mocks.candidate = transition(mocks.candidate) as Record<string, unknown> | null;
      } else {
        mocks.states.set(name, transition(mocks.states.get(name) ?? initial()));
      }
    },
  }),
}));
vi.mock("./workflow-state", async () => ({
  ...(await vi.importActual<{ assertExactWorkflowState: typeof assertExactWorkflowState }>(
    "./workflow-state",
  )),
  appBuilderWorkflowState: { get: () => mocks.workflow },
}));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async (ctx: { getSandbox: () => Promise<unknown> }) =>
    await ctx.getSandbox(),
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  DraftCandidateCreationUncertainError: class extends Error {},
  inspectDraftReconciliation: mocks.inspect,
  createDraftReconciliationCandidateFile: mocks.create,
  readDraftReconciliationCandidateFilePage: mocks.read,
  replaceDraftReconciliationCandidateText: mocks.replace,
  restoreDraftReconciliationCandidateFile: mocks.restore,
}));

vi.mock("../repository/sandbox-draft-schema-release", async (importOriginal) => ({
  ...(await importOriginal<{ draftSchemaReleaseId: typeof draftSchemaReleaseId }>()),
  discardUnissuedDraftSchemaRelease: mocks.discardSchema,
}));

const context = {
  callId: "seal",
  // oxlint-disable-next-line eslint/require-await -- Eve's sandbox accessor is asynchronous in production.
  async getSandbox() {
    return {};
  },
  session: { auth: {} },
} as never;

describe("draft reconciliation publication review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.states.clear();
    mocks.candidate = {
      appId: "spend-review",
      baseSha: sha,
      baseTree: sha,
      githubSourceDigest: digest,
      headSha: sha,
      headTree: sha,
      originalReviewDigest: digest,
      pullRequestNumber: 1500,
      review: { digest, resolvedTree: sha },
      root: "/workspace/.app-builder/draft-reconcile/candidate",
      validation: {
        resolvedTree: sha,
        compilation: {
          context: {
            authority: { ownerUserId: "owner" },
            target: { appId: "spend-review", sessionId: "session" },
          },
          release: { status: "not-required" },
        },
      },
    };
    mocks.workflow = {
      appSpec: { appId: "spend-review", digest },
      githubSource: { digest, repository: { repositoryId: "1" } },
      phase: "reviewed",
      reviewReceipt: { digest, appSpecDigest: digest, changeSetDigest: "d".repeat(64) },
    };
    mocks.inspect.mockResolvedValue({ resolvedTree: sha, unresolvedConflicts: [] });
    mocks.restore.mockResolvedValue({ digest, mode: "755" });
    mocks.create.mockImplementation(async (input: { assertCurrent?: () => void }) => {
      input.assertCurrent?.();
      return await Promise.resolve({ digest });
    });
    mocks.seal.mockResolvedValue({
      branchName: "app-builder/spend-review",
      digest: "c".repeat(64),
      expectedHeadSha: sha,
      name: "arrusted-development",
      owner: "withAutograph",
      repositoryId: "1",
    });
  });

  it.each(["current", "reconciled", "moved", "uncertain"] as const)(
    "uses only the exact owned open draft and retires stale proof when the cut may have moved (%s)",
    async (mode) => {
      const path = "apps/spend-review/schema/release/2026-11-16.v2";
      mocks.candidate = { ...mocks.candidate, repositoryId: "1", proposal: { digest } };
      const publishedReconciliation = { digest: "d".repeat(64) };
      if (mode === "reconciled") {
        mocks.candidate = { ...mocks.candidate, publishedReconciliation };
      }
      mocks.workflow = { ...mocks.workflow, publishedGitHubDraftProposalDigest: digest };
      const original = mocks.candidate;
      mocks.readOwnedDraft.mockResolvedValue({ pullRequestId: "57", idempotencyKey: digest });
      mocks.inspectOwnedDraft.mockResolvedValue({
        draft: {
          state: "open",
          draft: true,
          repositoryId: "1",
          number: 1500,
          pullRequestId: "57",
          verifiedBuilderOrigin: { marker: digest },
          headSha: sha,
          headTree: sha,
        },
        base: { headSha: mode === "moved" ? "c".repeat(40) : sha, headTree: sha },
        publishedHeadSha: sha,
      });
      mocks.discardSchema.mockImplementation(
        async (input: { assertCurrent: () => void; markUncertain: () => void }) => {
          input.assertCurrent();
          if (mode === "uncertain") {
            input.markUncertain();
            throw new Error("sandbox response lost");
          }
          return await Promise.resolve({ path });
        },
      );
      const attempted = editCandidate.execute(
        { kind: "discard_unissued_schema_release", releaseId: "2026-11-16.v2" },
        context,
      );
      if (mode === "moved") {
        await expect(attempted).rejects.toThrow("owned draft or its base has changed");
        expect(mocks.discardSchema).not.toHaveBeenCalled();
        expect(mocks.candidate).toBe(original);
        return;
      }
      await (mode === "uncertain"
        ? expect(attempted).rejects.toThrow("sandbox response lost")
        : expect(attempted).resolves.toMatchObject({ path, status: "candidate_edited" }));
      if (mode === "reconciled") {
        const [call] = mocks.inspectOwnedDraft.mock.calls;
        const request: unknown = call?.[0];
        expect(request).toMatchObject({ recovery: { reconciliations: [publishedReconciliation] } });
        expect(mocks.candidate).toHaveProperty("publishedReconciliation", publishedReconciliation);
      }
      expect(mocks.discardSchema).toHaveBeenCalledWith(
        expect.objectContaining({
          prepared: original,
          releaseId: "2026-11-16.v2",
          validatedTree: sha,
        }),
      );
      expect(mocks.candidate).not.toHaveProperty("proposal");
      expect(mocks.candidate).not.toHaveProperty("validation");
      expect(mocks.candidate).not.toHaveProperty("review");
    },
  );

  it("returns bounded candidate pages with continuation without invalidating review", async () => {
    const retained = mocks.candidate;
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    mocks.read.mockImplementation((input: { cursor?: number; expectedDigest?: string }) =>
      Promise.resolve({
        content: "bounded text",
        cursor: input.cursor ?? 0,
        digest: input.expectedDigest ?? digest,
        nextCursor: (input.cursor ?? 0) + 12,
        totalBytes: 100_000,
      }),
    );
    const expectedDigest = "c".repeat(64);
    const result = await editCandidate.execute(
      { cursor: 32_768, expectedDigest, kind: "read", path: "apps/demo/large.sql" },
      context,
    );
    expect(result).toEqual({
      content: "bounded text",
      cursor: 32_768,
      digest: expectedDigest,
      nextCursor: 32_780,
      path: "apps/demo/large.sql",
      status: "current_file",
      totalBytes: 100_000,
    });
    expect(mocks.candidate).toBe(retained);
    await expect(
      editCandidate.execute({ kind: "read", path: "apps/demo/file.txt" }, context),
    ).resolves.toMatchObject({ cursor: 0, digest, nextCursor: 12 });
  });

  it("creates a new app-owned file and invalidates only the current candidate proofs", async () => {
    const input = {
      content: "export const value = 1;\n",
      kind: "create",
      path: "apps/spend-review/src/data/new-record.ts",
    } as const;
    const publishedReconciliation = { digest: "published" };
    mocks.candidate = {
      ...mocks.candidate,
      proposal: { digest: "proposal" },
      publishedReconciliation,
      repairReview: { digest: "repair-review" },
      reviewReadProgress: { baseComplete: true, headComplete: true, reviewDigest: digest },
      validationRun: { nextIndex: 1, resolvedTree: sha },
    };
    const { workflow } = mocks;
    const createdFiles = new Map<string, string>();
    mocks.create.mockImplementation(
      async (creation: { assertCurrent?: () => void; content: string; path: string }) => {
        creation.assertCurrent?.();
        createdFiles.set(creation.path, creation.content);
        return await Promise.resolve({ digest });
      },
    );
    await expect(editCandidate.execute(input, context)).resolves.toMatchObject({
      digest,
      path: input.path,
      status: "candidate_edited",
    });
    expect(createdFiles.get(input.path)).toBe(input.content);
    for (const field of [
      "proposal",
      "review",
      "repairReview",
      "reviewReadProgress",
      "validation",
      "validationRun",
    ]) {
      expect(mocks.candidate).not.toHaveProperty(field);
    }
    expect(mocks.candidate).toMatchObject({ headSha: sha, publishedReconciliation });
    expect(mocks.workflow).toBe(workflow);
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("retains current candidate proofs when creating an existing file is rejected", async () => {
    const retained = mocks.candidate;
    mocks.create.mockRejectedValue(new Error("The app file already exists"));
    await expect(
      editCandidate.execute(
        { content: "new bytes", kind: "create", path: "apps/spend-review/existing.ts" },
        context,
      ),
    ).rejects.toThrow("already exists");
    expect(mocks.candidate).toBe(retained);
  });

  it("retires proof after a completed creation before surfacing cancellation", async () => {
    const controller = new AbortController();
    mocks.create.mockImplementation(async (input: { assertCurrent?: () => void }) => {
      input.assertCurrent?.();
      controller.abort();
      return await Promise.resolve({ digest });
    });
    await expect(
      editCandidate.execute(
        { content: "new bytes", kind: "create", path: "apps/spend-review/new.ts" },
        {
          abortSignal: controller.signal,
          getSandbox: async () => await Promise.resolve({}),
        } as never,
      ),
    ).rejects.toThrow();
    expect(mocks.candidate).not.toHaveProperty("validation");
    expect(mocks.candidate).not.toHaveProperty("review");
  });

  it.each([false, true])(
    "does not reuse uncertain creation proof or change a successor candidate (replaced: %s)",
    async (replaced) => {
      let successor: Record<string, unknown> | null = null;
      const uncertain = new DraftCandidateCreationUncertainError("Creation needs reconciliation");
      mocks.create.mockImplementation(async () => {
        if (replaced) {
          successor = { ...mocks.candidate, root: "/workspace/successor-candidate" };
          mocks.candidate = successor;
        }
        await Promise.resolve();
        throw uncertain;
      });
      await expect(
        editCandidate.execute(
          { content: "new bytes", kind: "create", path: "apps/spend-review/new.ts" },
          context,
        ),
      ).rejects.toBe(uncertain);
      if (replaced) {
        expect(mocks.candidate).toBe(successor);
        expect(mocks.candidate).toHaveProperty("review");
        expect(mocks.candidate).toHaveProperty("validation");
      } else {
        expect(mocks.candidate).not.toHaveProperty("review");
        expect(mocks.candidate).not.toHaveProperty("validation");
      }
    },
  );

  it.each(
    ["sandbox", "before-write"].flatMap((boundary) =>
      ["source", "review", "candidate", "cancelled"].map((change) => ({ boundary, change })),
    ),
  )(
    "rejects a $change change during $boundary acquisition before any file write",
    async ({ boundary, change }) => {
      const controller = new AbortController();
      let wrote = false;
      const changeCurrent = () => {
        if (change === "source") {
          mocks.workflow = { ...mocks.workflow, githubSource: { digest: "new-source" } };
        } else if (change === "review") {
          mocks.workflow = { ...mocks.workflow, reviewReceipt: { digest: "new-review" } };
        } else if (change === "candidate") {
          mocks.candidate = { ...mocks.candidate, root: "/workspace/new-candidate" };
        } else {
          controller.abort();
        }
      };
      mocks.create.mockImplementation(async (input: { assertCurrent?: () => void }) => {
        await Promise.resolve();
        if (boundary === "before-write") {
          changeCurrent();
        }
        input.assertCurrent?.();
        wrote = true;
        return { digest };
      });
      const creationContext = {
        abortSignal: controller.signal,
        callId: "create",
        getSandbox: async () => {
          await Promise.resolve();
          if (boundary === "sandbox") {
            changeCurrent();
          }
          return {};
        },
        session: { auth: {} },
      } as never;
      await expect(
        editCandidate.execute(
          { content: "new bytes", kind: "create", path: "apps/spend-review/new.ts" },
          creationContext,
        ),
      ).rejects.toThrow();
      expect(wrote).toBe(false);
      expect(mocks.candidate).toMatchObject({
        review: { digest },
        validation: { resolvedTree: sha },
      });
    },
  );

  it.each(["githubSource", "reviewReceipt"])(
    "rejects creation with a changed initial %s binding",
    async (field) => {
      const retained = mocks.candidate;
      mocks.workflow = { ...mocks.workflow, [field]: { digest: "changed" } };
      await expect(
        editCandidate.execute(
          { content: "new bytes", kind: "create", path: "apps/spend-review/new.ts" },
          context,
        ),
      ).rejects.toThrow("no longer matches the selected app and source review");
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.candidate).toBe(retained);
    },
  );

  it("restores from the retained candidate and invalidates saved validation and publication review", async () => {
    const publishedReconciliation = { digest: "published" };
    mocks.candidate = {
      ...mocks.candidate,
      proposal: { digest: "proposal" },
      publishedReconciliation,
      reviewReadProgress: { baseComplete: true, headComplete: true, reviewDigest: digest },
      validationRun: {
        commands: [{ command: "compile", exitCode: 0 }],
        nextIndex: 1,
        resolvedTree: sha,
      },
    };
    const retained = mocks.candidate;
    await expect(
      editCandidate.execute({ kind: "restore", path: "apps/demo/issued.bin" }, context),
    ).resolves.toMatchObject({
      digest,
      mode: "755",
      path: "apps/demo/issued.bin",
      status: "candidate_edited",
    });
    expect(mocks.restore).toHaveBeenCalledWith({
      path: "apps/demo/issued.bin",
      prepared: retained,
      sandbox: {},
    });
    for (const field of [
      "proposal",
      "review",
      "reviewReadProgress",
      "validation",
      "validationRun",
    ]) {
      expect(mocks.candidate).not.toHaveProperty(field);
    }
    expect(mocks.candidate).toMatchObject({ headSha: sha, publishedReconciliation });
  });

  it.each(["githubSource", "reviewReceipt"])(
    "rejects a restore after %s authority changes",
    async (field) => {
      mocks.workflow = { ...mocks.workflow, [field]: { digest: "changed" } };
      await expect(
        editCandidate.execute({ kind: "restore", path: "apps/demo/issued.bin" }, context),
      ).rejects.toThrow("no longer matches the selected app and source review");
      expect(mocks.restore).not.toHaveBeenCalled();
    },
  );

  it("preserves existing validation and review when a restore is rejected", async () => {
    const retained = mocks.candidate;
    mocks.restore.mockRejectedValue(new Error("absent from the retained draft head"));
    await expect(
      editCandidate.execute({ kind: "restore", path: "apps/demo/absent.bin" }, context),
    ).rejects.toThrow("absent from the retained draft head");
    expect(mocks.candidate).toBe(retained);
  });

  it.each([
    { name: "absent" },
    {
      name: "partial",
      progress: { baseComplete: true, headComplete: false, reviewDigest: digest },
    },
    {
      name: "stale",
      progress: { baseComplete: false, headComplete: false, reviewDigest: "old-review" },
    },
    {
      name: "complete",
      progress: { baseComplete: true, headComplete: true, reviewDigest: digest },
    },
  ])(
    "seals the exact validated tree with $name optional inspection progress",
    async ({ progress }) => {
      if (progress !== undefined) {
        mocks.candidate = { ...mocks.candidate, reviewReadProgress: progress };
      }
      await expect(
        sealReconciliation.execute({ expectedReviewDigest: digest }, context),
      ).resolves.toMatchObject({
        approvalReceipt: {
          baseRef: "refs/heads/app-builder/spend-review",
          baseSha: sha,
          outcome: "update-draft-pr",
          phase: "draft_update",
          subjectDigest: "c".repeat(64),
        },
        digest: "c".repeat(64),
      });
      expect(mocks.seal).toHaveBeenCalledOnce();
      expect(mocks.candidate).toHaveProperty("proposal.digest", "c".repeat(64));
      expect(draftReconciliationCompletions.get()).toMatchObject([
        {
          preparation: "sealed-before-approval",
          proposal: { digest: "c".repeat(64) },
          appReview: { appSpecDigest: digest, changeSetDigest: "d".repeat(64), digest },
          compilation: { release: { status: "not-required" } },
        },
      ]);
    },
  );

  it("keeps sealed completion context across edits and replacement candidates", async () => {
    await sealReconciliation.execute({ expectedReviewDigest: digest }, context);
    const sealed = structuredClone(draftReconciliationCompletions.get());
    await editCandidate.execute({ kind: "restore", path: "apps/spend-review/issued.bin" }, context);
    expect(draftReconciliationCompletions.get()).toEqual(sealed);
    mocks.candidate = null;
    expect(draftReconciliationCompletions.get()).toEqual(sealed);
    retainDraftReconciliationCompletion(sealed[0]);
    expect(draftReconciliationCompletions.get()).toEqual(sealed);
    expect(() => {
      retainDraftReconciliationCompletion({ ...sealed[0], root: "/workspace/unrelated" });
    }).toThrow("different approved context");
  });

  it("requires actual capture metadata before staging a publication context", async () => {
    mocks.candidate = { ...mocks.candidate, validation: { resolvedTree: sha } };
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow("completion_context_missing");
    expect(mocks.seal).not.toHaveBeenCalled();
    expect(draftReconciliationCompletions.get()).toEqual([]);
  });

  it.each([
    { field: "validation", reason: "candidate_validation_missing" },
    { field: "review", reason: "candidate_review_missing" },
  ])("refuses a missing candidate $field without publication", async ({ field, reason }) => {
    if (mocks.candidate === null) {
      throw new Error("Expected the retained fixture candidate.");
    }
    Reflect.deleteProperty(mocks.candidate, field);
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow(new RegExp(`^${reason} `, "u"));
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: "githubSource",
      value: { digest: "changed-source" },
      reason: "source_binding_changed",
    },
    {
      field: "reviewReceipt",
      value: { digest: "changed-app-review" },
      reason: "app_review_changed",
    },
  ])("refuses changed $field authority without publication", async ({ field, value, reason }) => {
    mocks.workflow = { ...mocks.workflow, [field]: value };
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow(new RegExp(`^${reason} `, "u"));
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("refuses a stale requested reconciliation review without publication", async () => {
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: "old-review" }, context),
    ).rejects.toThrow(/^seal_review_input_changed /u);
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("refuses unresolved conflicts without publication", async () => {
    mocks.inspect.mockResolvedValue({
      resolvedTree: sha,
      unresolvedConflicts: ["apps/demo/main.ts"],
    });
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow("changed after review");
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("rejects a changed resolved tree after review", async () => {
    mocks.candidate = {
      ...mocks.candidate,
      reviewReadProgress: { baseComplete: true, headComplete: true, reviewDigest: digest },
    };
    mocks.inspect.mockResolvedValue({ resolvedTree: "d".repeat(40), unresolvedConflicts: [] });
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow("changed after review");
    expect(mocks.seal).not.toHaveBeenCalled();
  });
});
