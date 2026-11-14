/* oxlint-disable anti-slop/no-module-mocking -- Isolate session state, publication reads and artifact storage while exercising the recovery decision. */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readMergedReleaseSourceRecovery } from "./merged-release-source-recovery";

const mocks = vi.hoisted(() => ({
  completions: vi.fn(),
  runtime: vi.fn(),
  inspectHead: vi.fn(),
  inspectPullRequest: vi.fn(),
  readRelease: vi.fn(),
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationCompletions: { get: mocks.completions },
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: mocks.runtime,
}));
vi.mock("./compiled-operator-artifacts", () => ({
  readExactCompiledOperatorReleaseForSession: mocks.readRelease,
}));

type RecoveryRequest = Parameters<typeof readMergedReleaseSourceRecovery>[0];
const appId = "socket-label-log";
const releaseId = "2026-11-16.v8";
const releasePath = `apps/${appId}/schema/release/${releaseId}/app-artifact.json`;
const contextSession = { id: "current-owner-session", auth: { owner: "creator" } };
const repository = {
  repositoryId: "arrusted-repository",
  owner: "withAutograph",
  name: "arrusted-development",
};
const originalProposalDigest = "1".repeat(64);
const originalReceiptDigest = "2".repeat(64);
const reviewedHead = "3".repeat(40);
const resolvedTree = "4".repeat(40);
const mergeSha = "5".repeat(40);
const artifactRef = "retained-v8";
const appSpecDigest = "6".repeat(64);
const artifact = Buffer.from('{"version":"2026-11-16.v8"}');
const sql = Buffer.from("checked release member");

const request = (changes: readonly string[] = [`apps/${appId}/app/page.tsx`]): RecoveryRequest => {
  const current = {
    appSpec: { appId, digest: "7".repeat(64) },
    applyReceipt: {
      applyRoot: "/workspace/repository",
      changes: changes.map((path) => ({ path })),
    },
    githubSource: { repository, resolvedRef: "refs/heads/main" },
  };
  const ctx = {
    session: contextSession,
    callId: "schema-compilation",
    abortSignal: new AbortController().signal,
  };
  const input = {
    current,
    releaseId,
    ctx,
    installationId: "selected-installation",
  };
  // SAFETY: The test stubs the I/O boundary and supplies all fields the helper reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return input as never;
};

const completion = (repositoryId = repository.repositoryId) => ({
  appId,
  proposal: {
    ...repository,
    repositoryId,
    baseBranch: "main",
    branchName: "builder/socket-label-log",
    priorPublicationDigest: originalReceiptDigest,
    pullRequestNumber: 1822,
    resolvedTree,
  },
  publishedOrigin: { publicationProposalDigest: originalProposalDigest },
  publicationScope: { proposal: { digest: originalProposalDigest } },
  compilation: {
    release: { status: "published", selection: { releaseId, artifactRef, appSpecDigest } },
  },
});

const mergedPullRequest = {
  mergeCommitSha: mergeSha,
  reviewedRevision: true,
  reviewedTarget: { repositoryId: repository.repositoryId, pullRequestNumber: 1822 },
  state: "merged",
};

describe("recover a checked release from the app's merged source", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.completions.mockReturnValue([completion()]);
    mocks.runtime.mockResolvedValue({
      inspectPublishedReconciliationHead: mocks.inspectHead,
      inspectPublishedPullRequest: mocks.inspectPullRequest,
    });
    mocks.inspectHead.mockResolvedValue(reviewedHead);
    mocks.inspectPullRequest.mockResolvedValue(mergedPullRequest);
    mocks.readRelease.mockResolvedValue({
      selection: { publishedSource: { gitTree: resolvedTree } },
      files: { "app-artifact.json": artifact, "schema.sql": sql },
    });
  });

  it("returns only exact merged release digests from the same session and installation", async () => {
    const current = request();
    await expect(readMergedReleaseSourceRecovery(current)).resolves.toEqual({
      mergeSha,
      releaseId,
      files: {
        "app-artifact.json": createHash("sha256").update(artifact).digest("hex"),
        "schema.sql": createHash("sha256").update(sql).digest("hex"),
      },
    });
    expect(mocks.runtime).toHaveBeenCalledWith(contextSession.auth, {
      selectedInstallationId: current.installationId,
    });
    expect(mocks.inspectHead).toHaveBeenCalledWith(
      originalProposalDigest,
      expect.objectContaining({ priorPublicationDigest: originalReceiptDigest }),
    );
    expect(mocks.inspectPullRequest).toHaveBeenCalledWith(originalProposalDigest, reviewedHead);
    expect(mocks.readRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterSessionId: contextSession.id,
        appId,
        appSpecDigest: current.current.appSpec.digest,
        lookup: {
          artifactRef,
          appSpecDigest,
          publishedSource: {
            repositoryId: repository.repositoryId,
            branch: completion().proposal.branchName,
            gitSha: reviewedHead,
          },
        },
        sessionAuth: contextSession.auth,
      }),
    );
  });

  it.each([
    ["is open", { state: "open" }],
    ["has moved", { reviewedRevision: false }],
    [
      "belongs to another repository",
      { reviewedTarget: { ...mergedPullRequest.reviewedTarget, repositoryId: "other-repository" } },
    ],
  ])("refuses a pull request that %s before reading stored artifacts", async (_reason, changes) => {
    mocks.inspectPullRequest.mockResolvedValue({ ...mergedPullRequest, ...changes });
    await expect(readMergedReleaseSourceRecovery(request())).resolves.toBeNull();
    expect(mocks.readRelease).not.toHaveBeenCalled();
  });

  it("refuses an archived release from a different reviewed tree", async () => {
    mocks.readRelease.mockResolvedValue({
      selection: { publishedSource: { gitTree: "e".repeat(40) } },
      files: { "app-artifact.json": artifact, "schema.sql": sql },
    });
    await expect(readMergedReleaseSourceRecovery(request())).resolves.toBeNull();
  });

  it("leaves approved edits and history from another repository untouched", async () => {
    await expect(readMergedReleaseSourceRecovery(request([releasePath]))).resolves.toBeNull();
    mocks.completions.mockReturnValue([completion("other-repository")]);
    await expect(readMergedReleaseSourceRecovery(request())).resolves.toBeNull();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});
