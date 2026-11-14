/* oxlint-disable anti-slop/no-module-mocking -- Isolate session state, publication reads and artifact storage while exercising the recovery decision. */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readMergedReleaseSourceRecovery,
  retainedMergedSchemaReleaseId,
} from "./merged-release-source-recovery";

const mocks = vi.hoisted(() => ({
  completions: vi.fn(),
  anchor: vi.fn(),
  runtime: vi.fn(),
  inspectHead: vi.fn(),
  inspectPullRequest: vi.fn(),
  readRelease: vi.fn(),
  readMergedCue: vi.fn(),
}));
vi.mock("./direct-production-state", () => ({
  retainedProductionSourceReconciliation: mocks.anchor,
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
const expectedBaseSha = "6".repeat(40);
const resolvedTree = "4".repeat(40);
const mergeSha = "5".repeat(40);
const artifactRef = "retained-v8";
const appSpecDigest = "6".repeat(64);
const selectedSchema = "9".repeat(64);
const selectedManifest = "a".repeat(64);
const reconciliationDigest = "b".repeat(64);
const priorReviewDigest = "c".repeat(64);
const artifact = Buffer.from('{"version":"2026-11-16.v8"}');
const sql = Buffer.from("checked release member");
const cuePath = `apps/${appId}/schema/${appId}.cue`;
const cueSha256 = "d".repeat(64);

const request = (changes: readonly string[] = [`apps/${appId}/app/page.tsx`]): RecoveryRequest => {
  const current = {
    appSpec: { appId, digest: "7".repeat(64) },
    proposal: { digest: "8".repeat(64) },
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

const completion = (repositoryId = repository.repositoryId, manifestSha256 = selectedManifest) => ({
  appId,
  preparation: "sealed-before-approval",
  proposal: {
    digest: reconciliationDigest,
    reviewDigest: priorReviewDigest,
    ...repository,
    repositoryId,
    baseBranch: "main",
    branchName: "builder/socket-label-log",
    priorPublicationDigest: originalReceiptDigest,
    pullRequestNumber: 1822,
    resolvedTree,
    expectedHeadSha: reviewedHead,
    expectedBaseSha,
  },
  publishedOrigin: { publicationProposalDigest: originalProposalDigest },
  publicationScope: { proposal: { digest: originalProposalDigest } },
  compilation: {
    release: {
      status: "published",
      selection: {
        releaseId,
        artifactRef,
        appSpecDigest,
        schemaSha256: selectedSchema,
        manifestSha256,
      },
    },
  },
});

const mergedPullRequest = {
  mergeCommitSha: mergeSha,
  reviewedRevision: true,
  reviewedTarget: { repositoryId: repository.repositoryId, pullRequestNumber: 1822 },
  state: "merged",
};

const deliveredAnchor = {
  digest: reconciliationDigest,
  originPublicationDigest: originalProposalDigest,
  originPublicationReceiptDigest: originalReceiptDigest,
  resolvedTree,
  pullRequestNumber: 1822,
  reviewDigest: priorReviewDigest,
  expectedHeadSha: reviewedHead,
  expectedBaseSha,
};
const archivedManifest = (manifest: Buffer, changedAfterCapture = false) => {
  const hash = createHash("sha256").update(manifest).digest("hex");
  mocks.completions.mockReturnValue([completion(repository.repositoryId, hash)]);
  mocks.readRelease.mockResolvedValue({
    selection: {
      releaseId,
      schemaSha256: selectedSchema,
      manifestSha256: hash,
      publishedSource: { gitTree: resolvedTree },
    },
    files: {
      "app-artifact.json": artifact,
      "schema.sql": sql,
      "release-manifest.json": changedAfterCapture
        ? Buffer.concat([manifest, Buffer.from(" ")])
        : manifest,
    },
  });
};

describe("recover a checked release from the app's merged source", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.completions.mockReturnValue([completion()]);
    mocks.runtime.mockResolvedValue({
      inspectPublishedReconciliationHead: mocks.inspectHead,
      inspectPublishedPullRequest: mocks.inspectPullRequest,
      readMergedAppSchemaCue: mocks.readMergedCue,
    });
    mocks.inspectHead.mockResolvedValue(reviewedHead);
    mocks.inspectPullRequest.mockResolvedValue(mergedPullRequest);
    mocks.readRelease.mockResolvedValue({
      selection: {
        releaseId,
        schemaSha256: selectedSchema,
        manifestSha256: selectedManifest,
        publishedSource: { gitTree: resolvedTree },
      },
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
        },
        sessionAuth: contextSession.auth,
      }),
    );
  });

  it("reads the requested CUE digest from the exact delivered anchor and archived manifest", async () => {
    archivedManifest(
      Buffer.from(
        JSON.stringify({
          app: appId,
          schema_version: releaseId,
          sources: { [cuePath]: `sha256:${cueSha256}` },
        }),
      ),
    );
    mocks.anchor.mockReturnValue({ ...deliveredAnchor, digest: "7".repeat(64) });
    const input = {
      ...request([releasePath]),
      reconciliationAnchor: deliveredAnchor,
      includeSchemaCue: true as const,
    };
    expect(retainedMergedSchemaReleaseId("current-planning-proposal", appId, deliveredAnchor)).toBe(
      releaseId,
    );
    await expect(readMergedReleaseSourceRecovery(input)).resolves.toMatchObject({
      mergeSha,
      releaseId,
      cueSha256,
    });
    expect(mocks.anchor).not.toHaveBeenCalled();
  });

  it("returns CUE bytes only if the exact reviewed merge matches the archived source digest", async () => {
    const bytes = Buffer.from("app: socket-label-log\n");
    const cueHash = createHash("sha256").update(bytes).digest("hex");
    archivedManifest(
      Buffer.from(
        JSON.stringify({
          app: appId,
          schema_version: releaseId,
          sources: { [cuePath]: `sha256:${cueHash}` },
        }),
      ),
    );
    const input = {
      ...request(),
      reconciliationAnchor: deliveredAnchor,
      includeSchemaCue: true as const,
      includeSchemaCueBytes: true as const,
    };
    mocks.readMergedCue.mockResolvedValueOnce(bytes).mockResolvedValueOnce(Buffer.from("other"));
    await expect(readMergedReleaseSourceRecovery(input)).resolves.toMatchObject({
      cueBytes: bytes,
      cueSha256: cueHash,
    });
    expect(mocks.readMergedCue).toHaveBeenCalledWith({
      appId,
      merged: { ...repository, baseBranch: "main", sha: mergeSha },
    });
    const stale = await readMergedReleaseSourceRecovery(input);
    expect(stale?.cueBytes).toBeUndefined();
    expect(stale?.cueSha256).toBe(cueHash);
  });

  it.each([
    ["missing CUE", {}],
    ["other app's CUE", { "apps/other/schema/other.cue": `sha256:${cueSha256}` }],
    ["malformed digest", { [cuePath]: "sha256:not-a-digest" }],
  ])(
    "treats an archived manifest with %s as unavailable when requested",
    async (_reason, sources) => {
      archivedManifest(
        Buffer.from(JSON.stringify({ app: appId, schema_version: releaseId, sources })),
      );
      await expect(
        readMergedReleaseSourceRecovery({ ...request(), includeSchemaCue: true }),
      ).resolves.toBeNull();
    },
  );

  it("cannot prove CUE by reading modified archived manifest bytes", async () => {
    archivedManifest(
      Buffer.from(
        JSON.stringify({
          app: appId,
          schema_version: releaseId,
          sources: { [cuePath]: `sha256:${cueSha256}` },
        }),
      ),
      true,
    );
    await expect(
      readMergedReleaseSourceRecovery({ ...request(), includeSchemaCue: true }),
    ).resolves.toBeNull();
  });

  it("does not fall back to another completion when the supplied anchor does not match", async () => {
    const reconciliationAnchor = { ...deliveredAnchor, expectedBaseSha: "e".repeat(40) };
    expect(
      retainedMergedSchemaReleaseId("current-planning-proposal", appId, reconciliationAnchor),
    ).toBeUndefined();
    await expect(
      readMergedReleaseSourceRecovery({ ...request(), reconciliationAnchor }),
    ).resolves.toBeNull();
    expect(mocks.runtime).not.toHaveBeenCalled();
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

  it("uses the retained predecessor when a legacy seal has no embedded publication origin", async () => {
    const { appId: preservedAppId, preparation, proposal, compilation } = completion();
    mocks.completions.mockReturnValue([
      { appId: preservedAppId, preparation, proposal, compilation },
    ]);
    const anchor = { ...deliveredAnchor };
    mocks.anchor.mockReturnValue({ ...anchor, reviewDigest: "d".repeat(64) });
    await expect(readMergedReleaseSourceRecovery(request())).resolves.toBeNull();
    expect(mocks.inspectHead).not.toHaveBeenCalled();
    mocks.anchor.mockReturnValue(anchor);
    mocks.readRelease.mockResolvedValue({
      selection: { releaseId, schemaSha256: selectedSchema, manifestSha256: selectedManifest },
      files: { "app-artifact.json": artifact, "sql-bundle.sql": sql },
    });
    await expect(readMergedReleaseSourceRecovery(request())).resolves.toMatchObject({
      mergeSha,
      releaseId,
    });
    expect(mocks.inspectHead).toHaveBeenCalledWith(originalProposalDigest, proposal);
  });

  it("refuses an archived release from a different reviewed tree", async () => {
    mocks.readRelease.mockResolvedValue({
      selection: {
        releaseId,
        schemaSha256: selectedSchema,
        manifestSha256: selectedManifest,
        publishedSource: { gitTree: "e".repeat(40) },
      },
      files: { "app-artifact.json": artifact, "schema.sql": sql },
    });
    await expect(readMergedReleaseSourceRecovery(request())).resolves.toBeNull();
  });

  it("leaves approved edits and history from another repository untouched", async () => {
    await expect(readMergedReleaseSourceRecovery(request([releasePath]))).resolves.toBeNull();
    await expect(
      readMergedReleaseSourceRecovery({
        ...request([releasePath]),
        reconciliationAnchor: deliveredAnchor,
      }),
    ).resolves.toBeNull();
    await expect(
      readMergedReleaseSourceRecovery({ ...request([releasePath]), includeSchemaCue: true }),
    ).resolves.toBeNull();
    mocks.completions.mockReturnValue([completion("other-repository")]);
    await expect(readMergedReleaseSourceRecovery(request())).resolves.toBeNull();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});
