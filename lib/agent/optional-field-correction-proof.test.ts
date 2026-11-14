import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";

import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import type { GeneratedAppReleaseFiles } from "../provisioning/hosted-operator-sandbox-launcher";
import type { OverlayChange } from "../repository/target-apply";
import { readOptionalFieldCorrectionProof } from "./optional-field-correction-proof";

type Input = Parameters<typeof readOptionalFieldCorrectionProof>[0];
type Reads = NonNullable<Parameters<typeof readOptionalFieldCorrectionProof>[1]>;
const appId = "equipment-log";
const appSpecDigest = "a".repeat(64);
const oldPriorCue = "1".repeat(64);
const oldCandidateCue = "2".repeat(64);
const activePriorCue = "3".repeat(64);
const nextCandidateCue = "4".repeat(64);
const priorMergeSha = "1".repeat(40);
const version = "fixture.v9";
const priorVersion = "fixture.v8";
const repositoryId = "123";
const repository = { repositoryId, owner: "withAutograph", name: "arrusted-development" };
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const installationId = "456";

const captured = (releaseId: string, name: string, spec = appSpecDigest) => {
  const files: GeneratedAppReleaseFiles = {
    "app-artifact.json": Buffer.from(`artifact ${name}`),
    "cue-to-sql-source-map.json": Buffer.alloc(0),
    "data-operations.md": Buffer.alloc(0),
    "data-operations.ts": Buffer.alloc(0),
    "data-server.ts": Buffer.alloc(0),
    "operation-manifest.json": Buffer.alloc(0),
    "release-manifest.json": Buffer.from(`manifest ${name}`),
    "runtime-coverage.json": Buffer.alloc(0),
    "sql-bundle.sql": Buffer.alloc(0),
    "sql-manifest.json": Buffer.alloc(0),
    "transition-contract.json": Buffer.alloc(0),
    "transition-plan.json": Buffer.alloc(0),
  };
  const selection: CompiledOperatorReleaseSelection = {
    version: 1,
    appId,
    appSpecDigest: spec,
    artifactRef: `_protected-operator/artifacts/generated-release/${appId}/${digest(name)}`,
    schemaSha256: digest(files["app-artifact.json"]),
    manifestSha256: digest(files["release-manifest.json"]),
    releaseId,
  };
  return { files, selection };
};
const edit = (path: string, before: string, after: string): OverlayChange => ({
  path,
  kind: "modified",
  before: { digest: before, mode: "644" },
  after: { digest: after, mode: "644" },
});
const unexpected = (): never => {
  throw new Error("A proof request should not modify the session or obtain a credential.");
};

const fixture = () => {
  const ctx: ToolContext = {
    abortSignal: new AbortController().signal,
    callId: "release-proof",
    getSandbox: unexpected,
    getToken: unexpected,
    requireAuth: unexpected,
    session: {
      auth: { current: null, initiator: null },
      id: "current-session",
      turn: { id: "proof", sequence: 1 },
    },
    toolName: "release-app-production",
  };
  const original = captured(version, "original");
  const next = captured(version, "corrected");
  const originalPrior = captured(priorVersion, "stale prior", "5".repeat(64));
  const activePrior = captured(priorVersion, "active prior", "6".repeat(64));
  const coordinate = { version: priorVersion };
  original.files["transition-plan.json"] = Buffer.from(
    JSON.stringify({
      online_optional_text_addition: {
        kind: "optional-text-addition-v1",
        predecessor_artifact_sha256: originalPrior.selection.schemaSha256,
        predecessor_schema: coordinate,
        model_id: "asset",
        field_id: "calibration_reference",
      },
    }),
  );
  original.files["operation-manifest.json"] = Buffer.from(
    JSON.stringify({
      predecessorCompatibility: {
        kind: "optional-text-addition-v1",
        predecessors: [
          {
            artifactSha256: originalPrior.selection.schemaSha256,
            schema: coordinate,
            field: { modelId: "asset", fieldId: "calibration_reference" },
          },
        ],
      },
    }),
  );
  const branchName = "builder/equipment-log";
  const headSha = "2".repeat(40);
  const headTree = "3".repeat(40);
  const baseSha = "4".repeat(40);
  const baseTree = "5".repeat(40);
  const resolvedTree = "6".repeat(40);
  original.selection.publishedSource = {
    repositoryId,
    branch: branchName,
    gitSha: headSha,
    gitTree: headTree,
    changeSetDigest: digest("published changes"),
    reviewDigest: digest("published review"),
  };
  const prefix = `apps/${appId}/schema/release/${version}`;
  const headChanges = [
    edit(
      `${prefix}/app-artifact.json`,
      original.selection.schemaSha256,
      next.selection.schemaSha256,
    ),
    edit(
      `${prefix}/release-manifest.json`,
      original.selection.manifestSha256,
      next.selection.manifestSha256,
    ),
  ];
  const review = {
    appId,
    baseSha,
    baseTree,
    headSha,
    headTree,
    resolvedTree,
    headChanges,
    digest: digest("correction-review"),
  };
  const pullRequestNumber = 302;
  const proposal = {
    ...repository,
    baseBranch: "main",
    branchName,
    expectedHeadSha: headSha,
    expectedHeadTree: headTree,
    expectedBaseSha: baseSha,
    expectedBaseTree: baseTree,
    headChangesDigest: digest(JSON.stringify(headChanges)),
    pullRequestNumber,
    resolvedTree,
    reviewDigest: review.digest,
  };
  const schemaChange = {
    kind: "add-optional-text-field",
    priorCueSha256: activePriorCue,
    candidateCueSha256: nextCandidateCue,
  };
  const baseSubject = {
    appId,
    baseBranch: "main",
    buildWorkspaceId: "owner-workspace",
    installationId,
    repositoryId,
    repositoryFullName: "withAutograph/arrusted-development",
    sessionId: ctx.session.id,
  };
  const predecessorAnchor = { pullRequestNumber: 300 };
  const predecessorGrant = {
    digest: digest("prior-grant"),
    subject: {
      ...baseSubject,
      proposalDigest: digest("prior-proposal"),
      revision: { reconciliation: predecessorAnchor },
    },
  };
  const originalGrant = {
    digest: digest("original-grant"),
    subject: {
      ...baseSubject,
      appSpecDigest,
      proposalDigest: digest("current-proposal"),
      revision: {
        priorGrantDigest: predecessorGrant.digest,
        priorProposalDigest: predecessorGrant.subject.proposalDigest,
        schemaChange: {
          ...schemaChange,
          priorCueSha256: oldPriorCue,
          candidateCueSha256: oldCandidateCue,
        },
      },
    },
  };
  const root = "/workspace/corrected";
  const current = {
    appSpec: { appId, digest: appSpecDigest },
    proposal: { digest: originalGrant.subject.proposalDigest },
    applyReceipt: { applyRoot: "/workspace/original", changes: [] },
    githubSource: { repository, resolvedRef: "refs/heads/main" },
  };
  const request = {
    ctx,
    current,
    candidate: {
      appId,
      root,
      repositoryId,
      pullRequestNumber,
      headSha,
      headTree,
      baseSha,
      baseTree,
      review,
    },
    originalGrant,
    predecessorGrant,
    corrected: {
      proposal,
      selection: next.selection,
      schemaChange,
      originPublicationDigest: digest("origin"),
    },
    priorMergeSha,
  };
  // SAFETY: The adapter only reads the illustrated fields. Existing tests cover the signed grant,
  // reconciliation proposal parsing, and provider preflight that precede this adapter.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const input: Input = request as never;
  const installed = {
    version: 1 as const,
    appId,
    repositoryId,
    releaseId: priorVersion,
    artifactSha256: activePrior.selection.schemaSha256,
    manifestSha256: activePrior.selection.manifestSha256,
    cueSha256: activePriorCue,
  };
  const published = {
    mergeSha: priorMergeSha,
    releaseId: priorVersion,
    cueSha256: activePriorCue,
    files: Object.fromEntries(
      Object.entries(activePrior.files).map(([member, bytes]) => [member, digest(bytes)]),
    ),
  };
  const reads = {
    readInstalled: vi.fn<Reads["readInstalled"]>().mockResolvedValue(installed),
    readMergedSource: vi.fn<Reads["readMergedSource"]>().mockResolvedValue(published),
    readRelease: vi
      .fn<Reads["readRelease"]>()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce(activePrior)
      .mockResolvedValueOnce(originalPrior),
    verify: vi.fn<Reads["verify"]>().mockReturnValue(true),
  };
  return { input, reads, original, next, activePrior, installed, published };
};

describe("read-only evidence for retaining a Production schema approval", () => {
  it("uses the original published tree, active readback, exact predecessor merge, and sealed capture", async () => {
    const { input, reads, original, next, installed } = fixture();
    await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toEqual({
      proof: {
        priorMergeSha,
        originalReleaseManifestSha256: original.selection.manifestSha256,
        installed: {
          releaseId: installed.releaseId,
          artifactSha256: installed.artifactSha256,
          manifestSha256: installed.manifestSha256,
          cueSha256: installed.cueSha256,
        },
        candidate: {
          releaseId: next.selection.releaseId,
          artifactSha256: next.selection.schemaSha256,
          manifestSha256: next.selection.manifestSha256,
        },
      },
    });
    expect(reads.readInstalled).toHaveBeenCalledExactlyOnceWith(appId, input.ctx);
    expect(reads.readMergedSource).toHaveBeenCalledExactlyOnceWith({
      current: input.current,
      ctx: input.ctx,
      installationId,
      releaseId: priorVersion,
      includeSchemaCue: true,
      includeSchemaCueBytes: true,
      reconciliationAnchor: input.predecessorGrant.subject.revision?.reconciliation,
    });
    const { proposal } = input.corrected;
    expect(reads.readRelease.mock.calls[0]?.[0].lookup).toEqual({
      appSpecDigest,
      releaseId: version,
      schemaSha256: original.selection.schemaSha256,
      manifestSha256: original.selection.manifestSha256,
      publishedSource: {
        repositoryId,
        branch: proposal.branchName,
        gitSha: proposal.expectedHeadSha,
      },
    });
    expect(reads.verify).toHaveBeenCalledOnce();
  });

  it("stops when the installed schema still has the stale source", async () => {
    const { input, reads, installed } = fixture();
    reads.readInstalled.mockResolvedValue({ ...installed, cueSha256: oldPriorCue });
    await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toEqual({
      reason: "installed-identity",
    });
    expect(reads.readRelease).not.toHaveBeenCalled();
  });

  it("stops when a different earlier merge is observed", async () => {
    const { input, reads, published } = fixture();
    reads.readMergedSource.mockResolvedValue({ ...published, mergeSha: "9".repeat(40) });
    await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toEqual({
      reason: "merged-predecessor",
    });
    expect(reads.verify).not.toHaveBeenCalled();
  });

  it.each([{ gitTree: "9".repeat(40) }, { branch: "other-branch" }, { repositoryId: "999" }])(
    "refuses an original capture from a different publication (%j)",
    async (change) => {
      const { input, reads, original } = fixture();
      if (original.selection.publishedSource === undefined) {
        throw new Error("Publication fixture required");
      }
      Object.assign(original.selection.publishedSource, change);
      await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toEqual({
        reason: "original-draft-archive",
      });
      expect(reads.verify).not.toHaveBeenCalled();
    },
  );

  it("rejects a predecessor grant from another GitHub installation", async () => {
    const { input, reads } = fixture();
    input.predecessorGrant.subject.installationId = "999";
    await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toEqual({
      reason: "correction-source-scope",
    });
    expect(reads.readInstalled).not.toHaveBeenCalled();
  });

  it("requires merged CUE proof if the old retained predecessor is missing", async () => {
    const { input, reads, original, next, activePrior } = fixture();
    reads.readRelease
      .mockReset()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce(activePrior)
      .mockImplementationOnce(async () => {});
    await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toEqual({
      reason: "original-predecessor-archive",
    });
    expect(reads.verify).not.toHaveBeenCalled();
  });

  it("supplies verified merged CUE when the stale predecessor archive is absent", async () => {
    const { input, reads, original, next, activePrior, published } = fixture();
    reads.readRelease
      .mockReset()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce(activePrior)
      .mockImplementationOnce(async () => {});
    const cueBytes = Buffer.from("verified merged source");
    reads.readMergedSource.mockResolvedValue({ ...published, cueBytes });
    await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toMatchObject({
      proof: { priorMergeSha },
    });
    expect(reads.verify).toHaveBeenCalledOnce();
    const verifierInput = reads.verify.mock.calls[0]?.[0];
    expect(verifierInput?.original.prior).toBeUndefined();
    expect(verifierInput?.publishedPriorCue).toEqual(cueBytes);
  });

  it("cannot use merged CUE when the stale predecessor archive lookup throws", async () => {
    const { input, reads, original, next, activePrior, published } = fixture();
    reads.readRelease
      .mockReset()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce(activePrior)
      .mockRejectedValueOnce(new Error("opaque archive failure"));
    reads.readMergedSource.mockResolvedValue({
      ...published,
      cueBytes: Buffer.from("verified merged source"),
    });
    await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toEqual({
      reason: "original-predecessor-archive",
    });
    expect(reads.verify).not.toHaveBeenCalled();
  });

  it("stops before readback when the retained review does not hash to the proposal", async () => {
    const { input, reads } = fixture();
    input.corrected.proposal.headChangesDigest = digest("stale");
    await expect(readOptionalFieldCorrectionProof(input, reads)).resolves.toEqual({
      reason: "correction-source-scope",
    });
    expect(reads.readInstalled).not.toHaveBeenCalled();
  });
});
