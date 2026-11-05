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
import type { OwnedPublicationReconciliationScope } from "../repository/github-draft-reconciliation";

type Fixture = Awaited<ReturnType<typeof freshFixture>>;
type Candidate = DraftReconciliationCandidate & {
  publishedOrigin: PublishedDraftRepairSource;
  publicationScope: OwnedPublicationReconciliationScope;
  reviewedLineage: Fixture["reviewed"];
  unpublished: string;
};
type Workflow = Fixture["currentContext"][typeof workflowKey];
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
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the validated workflow and exact candidate/private edits when normal preparation reuses it", async () => {
    const before = structuredClone(mocks.candidate);
    const workflow = structuredClone(mocks.workflow);
    const result = await preparePublishedDraftReconciliation({
      state: fixture.reviewed,
      ctx,
      pullRequestNumber: 42,
    });
    expect(result.root).toBe(before.root);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    const request = mocks.prepare.mock.calls[0][0];
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
          state: fixture.reviewed,
          ctx,
          pullRequestNumber: 42,
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
      preparePublishedDraftReconciliation({ state: fixture.reviewed, ctx, pullRequestNumber: 42 }),
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
      state: fixture.reviewed,
      ctx,
      pullRequestNumber: 42,
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
      preparePublishedDraftReconciliation({ state: fixture.reviewed, ctx, pullRequestNumber: 42 }),
    ).rejects.toThrow("another session");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
