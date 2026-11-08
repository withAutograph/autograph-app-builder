/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Only external provider and Eve-state boundaries are controlled; the real preparation and source resolver run. */
/* oxlint-disable eslint/require-await -- External provider boundaries use the production async signatures. */
import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import type {
  RepositoryAccessReceipt,
  repositoryAccessReceiptSchema,
} from "./repository-access-state";
import { isDeepStrictEqual } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePublishedDraftReconciliation } from "./prepare-published-draft-repair";
import { freshFixture, workflowKey } from "../eve/test-support/draft-reviewed-recovery";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import type { PublishedDraftRepairSource } from "./published-draft-repair";
import { retainedPublishedDraftOriginForReview } from "./published-draft-repair";
import type { observeNormalizedChangeSet } from "../../agent/tools/change_set_status";
import type { readPreparedSandboxSourceManifest } from "../repository/supported-template";
import type { OwnedPublicationReconciliationScope } from "../repository/github-draft-reconciliation";

type Fixture = Awaited<ReturnType<typeof freshFixture>>;
type Candidate = DraftReconciliationCandidate & {
  publishedOrigin: PublishedDraftRepairSource;
  publicationScope: OwnedPublicationReconciliationScope;
  reviewedLineage: Fixture["reviewed"];
  unpublished: string;
};
type Workflow = Fixture["currentContext"][typeof workflowKey] | Fixture["reviewed"];
interface Owned {
  draft: PublishedDraftRepairSource["draft"];
  source: PublishedDraftRepairSource["source"];
  proposal: OwnedPublicationReconciliationScope["proposal"];
  publication: OwnedPublicationReconciliationScope["publication"];
}
const signAccess = (
  unsigned: Omit<RepositoryAccessReceipt, "digest">,
): RepositoryAccessReceipt => ({
  ...unsigned,
  digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
});
interface PrepareRequest {
  previousCandidate: Candidate;
  replayPreviousCandidate?: boolean;
  forceFreshCandidate?: boolean;
}

const mocks = vi.hoisted(() => ({
  workflow: undefined as unknown as Workflow,
  candidate: undefined as unknown as Candidate,
  access: undefined as unknown as RepositoryAccessReceipt,
  owned: undefined as unknown as Owned,
  onOwnedRead: undefined as undefined | (() => void),
  ownedProposalDigests: [] as string[],
  onSourceRead: undefined as undefined | (() => void),
  prepare: vi.fn<(request: PrepareRequest) => Promise<Candidate & { created: boolean }>>(),
}));

vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: { get: () => mocks.workflow },
  updateExactWorkflow: ({
    expected,
    transition,
  }: {
    expected: Workflow;
    transition: () => Workflow;
  }) => {
    if (!isDeepStrictEqual(mocks.workflow, expected)) {
      throw new Error("The app workflow changed during publication recovery.");
    }
    mocks.workflow = transition();
  },
}));
// This fixture models an ordinary new Build, not resumeApprovedBuild history.
vi.mock("./existing-app-repair-planning", () => ({
  priorResumedBuildDraftProposal: () => {},
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationCompletions: { get: () => [] },
  draftReconciliationState: { get: () => mocks.candidate },
  publishedDraftRepairCompletions: { get: () => [] },
  samePersistedDraftCandidate: (left: unknown, right: unknown) =>
    // oxlint-disable-next-line unicorn/prefer-structured-clone, react-doctor/no-json-parse-stringify-clone -- Model the persisted JSON representation, which drops undefined fields.
    isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right))),
  updateExactDraftReconciliation: ({
    expected,
    transition,
  }: {
    expected: Candidate;
    transition: () => Candidate;
  }) => {
    if (
      !isDeepStrictEqual(
        // oxlint-disable-next-line unicorn/prefer-structured-clone, react-doctor/no-json-parse-stringify-clone -- Compare the persisted JSON representation.
        JSON.parse(JSON.stringify(expected)),
        // oxlint-disable-next-line unicorn/prefer-structured-clone, react-doctor/no-json-parse-stringify-clone -- Compare the persisted JSON representation.
        JSON.parse(JSON.stringify(mocks.candidate)),
      )
    ) {
      throw new Error("The draft candidate changed during preparation.");
    }
    mocks.candidate = transition();
  },
}));
vi.mock("./repository-access-state", async (importOriginal) => ({
  ...(await importOriginal<{
    repositoryAccessReceiptSchema: typeof repositoryAccessReceiptSchema;
  }>()),
  repositoryAccessReceiptState: { get: () => mocks.access },
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: async () => ({
    inspectExistingDraftReconciliationSource: async () => {
      mocks.onSourceRead?.();
      return { draft: mocks.owned.draft, base: { headSha: mocks.candidate.baseSha } };
    },
    inspectOwnedPublishedDraftRepairSource: async (request: {
      publishedProposalDigest: string;
    }) => {
      mocks.ownedProposalDigests.push(request.publishedProposalDigest);
      mocks.onOwnedRead?.();
      if (request.publishedProposalDigest !== mocks.owned.proposal.digest) {
        throw new Error("The original published draft proposal is unavailable in this tenant.");
      }
      return mocks.owned;
    },
  }),
}));
vi.mock("./deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: async () => ({
    acquireExistingSourceCredential: async () => "controlled",
  }),
}));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async () => ({ id: "controlled" }),
}));
vi.mock("./verified-github-fetch-recovery", () => ({
  prepareWithVerifiedGitHubFetchRecovery: async ({
    prepare,
  }: {
    prepare: () => Promise<unknown>;
  }) => ({ prepared: await prepare(), retriedGitFetch: false }),
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  prepareDraftReconciliation: mocks.prepare,
  preparePublishedDraftRepairCandidate: vi.fn(),
}));

const retainedSource = vi.hoisted(() => ({
  observed: vi.fn(),
  original: vi.fn(),
}));
vi.mock("../../agent/tools/change_set_status", async (importOriginal) => ({
  ...(await importOriginal<{ observeNormalizedChangeSet: typeof observeNormalizedChangeSet }>()),
  observeNormalizedChangeSet: retainedSource.observed,
}));
vi.mock("../repository/supported-template", async (importOriginal) => ({
  ...(await importOriginal<{
    readPreparedSandboxSourceManifest: typeof readPreparedSandboxSourceManifest;
  }>()),
  readPreparedSandboxSourceManifest: retainedSource.original,
}));

describe("owned fresh-template draft preparation after review recovery", () => {
  let fixture: Fixture;
  let root: string;
  const ctx = { callId: "prepare", session: { id: "logical-original", auth: {} } } as ToolContext;
  beforeEach(async () => {
    fixture = await freshFixture();
    root = mkdtempSync(path.join(tmpdir(), "builder-fresh-owned-"));
    writeFileSync(path.join(root, "candidate.txt"), "latest unpublished candidate bytes\n");
    mocks.workflow = structuredClone(fixture.currentContext[workflowKey]);
    mocks.candidate = {
      ...structuredClone(fixture.candidate),
      root,
      reviewedLineage: structuredClone(fixture.reviewed),
    };
    const origin = mocks.candidate.publishedOrigin;
    const scope = mocks.candidate.publicationScope;
    const { defaultBranch, headSha, headTree, name, owner, repositoryId } =
      origin.source.repository;
    mocks.access = signAccess({
      confirmedByCallId: "record-access",
      providerAccessDigest: origin.source.digest,
      repository: { defaultBranch, headSha, headTree, name, owner, repositoryId },
      scope: {
        accountLogin: owner,
        accountType: "Organization",
        installationId: origin.installationId,
      },
      sessionId: "logical-original",
      version: 1,
    });
    mocks.owned = {
      draft: origin.draft,
      source: origin.source,
      proposal: scope.proposal,
      publication: scope.publication,
    };
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    mocks.onOwnedRead = undefined;
    mocks.ownedProposalDigests = [];
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    mocks.onSourceRead = undefined;
    mocks.prepare.mockReset();
    mocks.prepare.mockImplementation(async (request) => ({
      ...structuredClone(mocks.candidate),
      root: request.previousCandidate.root,
      created: false,
    }));
  });
  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const reviewedNewBuild = () => {
    const state = structuredClone(fixture.reviewed);
    delete state.publishedGitHubDraftProposalDigest;
    state.proposal.digest = "1".repeat(64);
    state.applyReceipt = {
      ...state.applyReceipt,
      digest: "2".repeat(64),
      proposalDigest: state.proposal.digest,
    };
    state.reviewReceipt = { ...state.reviewReceipt, digest: "3".repeat(64) };
    mocks.workflow = state;
    return state;
  };

  it("recovers a lost publication marker after a new Build without losing its accepted private fixes", async () => {
    const state = reviewedNewBuild();
    const before = readFileSync(path.join(root, "candidate.txt"), "utf-8");
    const result = await preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state });
    expect(result).toMatchObject({ status: "ready_for_validation" });
    expect(mocks.ownedProposalDigests).toContain(mocks.owned.proposal.digest);
    expect(mocks.workflow).toMatchObject({
      publishedGitHubDraftProposalDigest: mocks.owned.proposal.digest,
      proposal: state.proposal,
      applyReceipt: state.applyReceipt,
      reviewReceipt: state.reviewReceipt,
    });
    expect(mocks.candidate.originalReviewDigest).toBe(state.reviewReceipt.digest);
    expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({
      unpublished: {
        reviewDigest: state.reviewReceipt.digest,
        changes: state.reviewReceipt.changes,
      },
    });
    expect(readFileSync(path.join(root, "candidate.txt"), "utf-8")).toBe(before);
  });

  it("supports a canonical retained repair without requiring reconciliation-only scope metadata", () => {
    const state = reviewedNewBuild();
    const { publicationScope: _scope, publishedOrigin, ...candidate } = mocks.candidate;
    void _scope;
    const repair: DraftReconciliationCandidate = {
      ...candidate,
      kind: "published-draft-repair",
      repair: publishedOrigin,
      baseSha: candidate.headSha,
      baseTree: candidate.headTree,
    };
    expect(retainedPublishedDraftOriginForReview(state, repair)?.digest).toBe(
      publishedOrigin.digest,
    );
  });

  it("uses the retained original before a newly sealed unpublished proposal", async () => {
    const state = reviewedNewBuild();
    state.githubDraftProposal = {
      proposal: { ...mocks.owned.proposal, digest: "4".repeat(64) },
      sourceReceiptDigest: state.sourceReceipt.digest,
      destinationReviewDigest: "5".repeat(64),
    };
    await preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state });
    expect(mocks.ownedProposalDigests).toContain(mocks.owned.proposal.digest);
    expect(mocks.ownedProposalDigests).not.toContain(state.githubDraftProposal.proposal.digest);
    expect(mocks.workflow).toMatchObject({ githubDraftProposal: state.githubDraftProposal });
  });

  it("never overrides a present contradictory publication marker with an old retained origin", async () => {
    const state = reviewedNewBuild();
    state.publishedGitHubDraftProposalDigest = "4".repeat(64);
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
    ).rejects.toThrow("The original published draft proposal is unavailable in this tenant.");
    expect(mocks.workflow.publishedGitHubDraftProposalDigest).toBe(
      state.publishedGitHubDraftProposalDigest,
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    "app",
    "spec",
    "source",
    "workspace",
    "path",
    "digest",
    "sha",
    "tree",
    "apply-root",
  ] as const)(
    "does not borrow a canonical retained origin across changed current %s binding",
    async (binding) => {
      const state = reviewedNewBuild();
      const change = {
        app: () => {
          state.appSpec.appId = "another-app";
        },
        spec: () => {
          state.appSpec.digest = "6".repeat(64);
        },
        source: () => {
          state.sourceReceipt.digest = "6".repeat(64);
        },
        workspace: () => {
          state.workspace.workspaceId = "another-workspace";
        },
        path: () => {
          // A controlled foreign persisted path must not borrow the original lookup.
          state.workspace.workspacePath =
            "/workspace/another" as typeof state.workspace.workspacePath;
        },
        digest: () => {
          state.workspace.workspaceDigest = "6".repeat(64);
        },
        sha: () => {
          state.workspace.sourceSha = "6".repeat(40);
        },
        tree: () => {
          state.workspace.sourceTree = "6".repeat(40);
        },
        "apply-root": () => {
          state.applyReceipt.applyRoot = "/workspace/another";
        },
      };
      change[binding]();
      await expect(
        preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
      ).rejects.toThrow(
        "The owned original draft publication or its repository access is unavailable",
      );
      expect(mocks.ownedProposalDigests).toEqual([]);
      expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["session", "repository", "installation"] as const)(
    "keeps lost-marker recovery bound to fresh %s access",
    async (binding) => {
      const state = reviewedNewBuild();
      const { digest: _digest, ...access } = mocks.access;
      void _digest;
      const changed = {
        ...access,
        sessionId: binding === "session" ? "another-session" : access.sessionId,
        repository: {
          ...access.repository,
          repositoryId: binding === "repository" ? "999" : access.repository.repositoryId,
        },
        scope: {
          ...access.scope,
          installationId: binding === "installation" ? "999" : access.scope.installationId,
        },
      };
      mocks.access = signAccess(changed);
      await expect(
        preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
      ).rejects.toThrow();
      expect(mocks.ownedProposalDigests).toEqual([]);
      expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("does not record recovered publication provenance when its provider read fails", async () => {
    const state = reviewedNewBuild();
    const candidate = structuredClone(mocks.candidate);
    mocks.onOwnedRead = () => {
      throw new Error("controlled GitHub ownership read failed");
    };
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
    ).rejects.toThrow("controlled GitHub ownership read failed");
    expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
    expect(mocks.candidate).toEqual(candidate);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("preserves cancellation after ownership read without recording the marker or preparing files", async () => {
    const state = reviewedNewBuild();
    const controller = new AbortController();
    mocks.onOwnedRead = () => {
      controller.abort();
    };
    await expect(
      preparePublishedDraftReconciliation({
        ctx: { ...ctx, abortSignal: controller.signal },
        pullRequestNumber: 42,
        state,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("rechecks the exact workspace after the owned publication read before recording recovery", async () => {
    const state = reviewedNewBuild();
    mocks.onOwnedRead = () => {
      mocks.workflow = {
        ...state,
        workspace: { ...state.workspace, workspaceId: "replaced-workspace" },
      };
    };
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
    ).rejects.toThrow("The accepted app workflow changed during draft repair preparation.");
    expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "restores a missing package and registration (starter repository: %s)",
    async (sameRepository) => {
      const state = structuredClone(fixture.reviewed);
      const appRoot = `apps/${state.appSpec.appId}`;
      retainedSource.original.mockReset();
      if (sameRepository) {
        mocks.owned.proposal = {
          ...mocks.owned.proposal,
          owner: "withAutograph",
          name: "arrusted-development",
        };
        retainedSource.original.mockRejectedValue(new Error("Prepared manifest missing"));
      } else {
        retainedSource.original.mockResolvedValue([
          { path: "microfrontends.json", mode: "100644", sha256: "starter" },
        ]);
      }
      retainedSource.observed.mockResolvedValue({
        observed: {
          treeDigest: "current",
          files: [
            { path: `${appRoot}/package.json`, mode: "644", digest: "manifest" },
            { path: `${appRoot}/app/page.tsx`, mode: "644", digest: "page" },
            { path: "microfrontends.json", mode: "644", digest: "registered" },
            { path: "apps/another/app/page.tsx", mode: "644", digest: "other" },
          ],
        },
      });
      await preparePublishedDraftReconciliation({
        ctx,
        pullRequestNumber: 42,
        restoreInitialAppSource: true,
        state,
      });
      const expectedUnpublished = () => {
        interface ExpectedUnpublishedSource {
          restoreInitialAppSource: boolean;
          initialSourceRevision?: { sha: string; tree: string };
        }
        const source: ExpectedUnpublishedSource = { restoreInitialAppSource: true };
        if (sameRepository) {
          source.initialSourceRevision = {
            sha: state.sourceReceipt.sourceSha,
            tree: state.sourceReceipt.sourceTree,
          };
        }
        return {
          ...source,
          changes: [
            { kind: "added", path: `${appRoot}/app/page.tsx` },
            { kind: "added", path: `${appRoot}/package.json` },
            sameRepository
              ? { kind: "added", path: "microfrontends.json" }
              : {
                  before: { digest: "starter", mode: "644" },
                  kind: "modified",
                  path: "microfrontends.json",
                },
          ],
        };
      };
      expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({
        forceFreshCandidate: true,
        ownedPublication: { proposal: mocks.owned.proposal, publication: mocks.owned.publication },
        unpublished: expectedUnpublished(),
      });
    },
  );

  it("keeps the validated workflow and exact candidate/private edits when normal preparation reuses it", async () => {
    const before = structuredClone(mocks.candidate);
    const workflow = structuredClone(mocks.workflow);
    const result = await preparePublishedDraftReconciliation({
      ctx,
      pullRequestNumber: 42,
      state: fixture.reviewed,
    });
    expect(result.root).toBe(before.root);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    const [[request]] = mocks.prepare.mock.calls;
    expect(request.previousCandidate).toEqual(before);
    expect(request.replayPreviousCandidate).toBe(true);
    expect(request.forceFreshCandidate).toBeUndefined();
    expect(mocks.candidate.unpublished).toBe(before.unpublished);
    expect(readFileSync(path.join(result.root, "candidate.txt"), "utf-8")).toBe(
      "latest unpublished candidate bytes\n",
    );
    expect(mocks.workflow).toEqual(workflow);
    expect(mocks.workflow.phase).toBe("validated");
  });

  it("passes explicit original-publication cleanup through the same owned app and retains private replay", async () => {
    const previous = structuredClone(mocks.candidate);
    await preparePublishedDraftReconciliation({
      state: fixture.reviewed,
      ctx,
      pullRequestNumber: 42,
      repairOriginalPublication: { discardAddedPaths: ["app/page.tsx"] },
    });
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({
      originalPublicationRepair: { discardAddedPaths: ["app/page.tsx"] },
      ownedPublication: { proposal: mocks.owned.proposal, publication: mocks.owned.publication },
      previousCandidate: { root: previous.root, appId: previous.appId },
      replayPreviousCandidate: true,
    });
    expect(readFileSync(path.join(previous.root, "candidate.txt"), "utf-8")).toBe(
      "latest unpublished candidate bytes\n",
    );
  });

  it("retains the original cleanup selection for a retry against the same owned head", async () => {
    mocks.candidate.originalPublicationRepair = { discardAddedPaths: ["app/page.tsx"] };
    await preparePublishedDraftReconciliation({
      state: fixture.reviewed,
      ctx,
      pullRequestNumber: 42,
    });
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({
      originalPublicationRepair: { discardAddedPaths: ["app/page.tsx"] },
      replayPreviousCandidate: true,
    });
  });

  it("retains the old owned candidate for inspection when a fresh review has a different digest", async () => {
    mocks.workflow = structuredClone(fixture.reviewed);
    mocks.candidate.originalReviewDigest = "e".repeat(64);
    const previous = structuredClone(mocks.candidate);
    mocks.prepare.mockImplementation(async () => ({
      ...structuredClone(previous),
      root: `${root}-new`,
      created: true,
    }));
    const result = await preparePublishedDraftReconciliation({
      ctx,
      pullRequestNumber: 42,
      recovery: "reopen-current-owned-draft",
      state: fixture.reviewed,
    });
    expect(mocks.prepare.mock.calls[0][0].previousCandidate).toBeUndefined();
    expect(result.preservedWorkspaces).toContainEqual({
      kind: "draft-candidate",
      reviewDigest: previous.originalReviewDigest,
      root,
    });
    expect(mocks.candidate.preservedWorkspaces).toContainEqual({
      kind: "draft-candidate",
      reviewDigest: previous.originalReviewDigest,
      root,
    });
    expect(readFileSync(path.join(root, "candidate.txt"), "utf-8")).toBe(
      "latest unpublished candidate bytes\n",
    );
  });

  it.each(["app", "repository", "pull-request", "publication", "installation"] as const)(
    "does not expose a candidate with a different %s as preserved work",
    async (difference) => {
      mocks.workflow = structuredClone(fixture.reviewed);
      if (difference === "app") {
        mocks.candidate.appId = "foreign-app";
      }
      if (difference === "repository") {
        mocks.candidate.repositoryId = "foreign-repository";
      }
      if (difference === "pull-request") {
        mocks.candidate.pullRequestNumber = 99;
      }
      if (difference === "publication") {
        mocks.candidate.publishedOrigin.publicationDigest = "f".repeat(64);
      }
      if (difference === "installation") {
        mocks.candidate.publishedOrigin.installationId = "foreign-installation";
      }
      const previous = structuredClone(mocks.candidate);
      mocks.prepare.mockImplementation(async () => ({
        ...structuredClone(previous),
        root: `${root}-new`,
        created: true,
      }));
      const result = await preparePublishedDraftReconciliation({
        ctx,
        pullRequestNumber: 42,
        recovery: "reopen-current-owned-draft",
        state: fixture.reviewed,
      });
      expect(mocks.prepare.mock.calls[0][0].previousCandidate).toBeUndefined();
      expect(result.preservedWorkspaces).not.toContainEqual(
        expect.objectContaining({ kind: "draft-candidate", root }),
      );
    },
  );

  it.each(["root", "source", "review"] as const)(
    "refuses a %s change during the first ownership read",
    async (variant) => {
      mocks.onOwnedRead = () => {
        if (variant === "root") {
          mocks.candidate = { ...mocks.candidate, root: "/workspace/other" };
        }
        if (variant === "source") {
          mocks.workflow = {
            ...mocks.workflow,
            sourceReceipt: { ...mocks.workflow.sourceReceipt, digest: "f".repeat(64) },
          };
        }
        if (variant === "review") {
          mocks.candidate = { ...mocks.candidate, originalReviewDigest: "e".repeat(64) };
        }
      };
      await expect(
        preparePublishedDraftReconciliation({
          ctx,
          pullRequestNumber: 42,
          state: fixture.reviewed,
        }),
      ).rejects.toThrow();
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("refuses a candidate replacement during draft source inspection before preparing a checkout", async () => {
    mocks.onSourceRead = () => {
      mocks.candidate = { ...mocks.candidate, root: "/workspace/replaced" };
    };
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state: fixture.reviewed }),
    ).rejects.toThrow("candidate changed");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("accepts an equivalent reordered candidate with an omitted optional value during inspection", async () => {
    mocks.onSourceRead = () => {
      mocks.candidate = {
        ...Object.fromEntries(Object.entries(mocks.candidate).toReversed()),
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
        review: undefined,
      } as Candidate;
    };
    const result = await preparePublishedDraftReconciliation({
      ctx,
      pullRequestNumber: 42,
      state: fixture.reviewed,
    });
    expect(result.root).toBe(root);
    expect(readFileSync(path.join(result.root, "candidate.txt"), "utf-8")).toBe(
      "latest unpublished candidate bytes\n",
    );
  });

  it("refuses a foreign session before reading the owned publication", async () => {
    const { digest, ...unsigned } = mocks.access;
    mocks.access = signAccess({ ...unsigned, sessionId: "foreign" });
    expect(mocks.access.digest).not.toBe(digest);
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state: fixture.reviewed }),
    ).rejects.toThrow("another session");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
