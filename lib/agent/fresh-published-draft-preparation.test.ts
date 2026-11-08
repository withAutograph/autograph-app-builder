/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Only external provider and Eve-state boundaries are controlled; the real preparation and source resolver run. */
/* oxlint-disable eslint/require-await -- External provider boundaries use the production async signatures. */
import { createHash } from "node:crypto";
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
  onSourceRead: undefined as undefined | (() => void),
  prepare: vi.fn<(request: PrepareRequest) => Promise<Candidate & { created: boolean }>>(),
}));

vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: () => mocks.workflow } }));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: () => mocks.candidate },
  draftReconciliationCompletions: { get: () => [] },
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
    inspectOwnedPublishedDraftRepairSource: async () => {
      mocks.onOwnedRead?.();
      return mocks.owned;
    },
    inspectExistingDraftReconciliationSource: async () => {
      mocks.onSourceRead?.();
      return { draft: mocks.owned.draft, base: { headSha: mocks.candidate.baseSha } };
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
  const ctx = { callId: "prepare", session: { id: "logical-original", auth: {} } } as never;
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
    mocks.onOwnedRead = undefined;
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
