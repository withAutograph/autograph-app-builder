import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";

import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { isEquivalentCompiledOperatorRelease } from "../provisioning/hosted-operator-artifact-selection";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import { verifyOptionalFieldCorrectionEquivalence } from "../provisioning/optional-field-correction-equivalence";
import type { OptionalFieldCorrectionFailure } from "../provisioning/optional-field-correction-equivalence";
import { readOptionalTextReleasePredecessor } from "../provisioning/repository-production-schema-revision";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import { readExactCompiledOperatorReleaseForSession } from "./compiled-operator-artifacts";
import type {
  DirectProductionGrant,
  DirectProductionSubject,
} from "./direct-production-authorization";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import { readInstalledSchemaPredecessor } from "./installed-schema-predecessor-readback";
import { readMergedReleaseSourceRecovery } from "./merged-release-source-recovery";

type SchemaChange = NonNullable<NonNullable<DirectProductionSubject["revision"]>["schemaChange"]>;
type MergedSourceInput = Parameters<typeof readMergedReleaseSourceRecovery>[0];
type Predecessor = NonNullable<Awaited<ReturnType<typeof readInstalledSchemaPredecessor>>>;
type CapturedRelease = NonNullable<
  Awaited<ReturnType<typeof readExactCompiledOperatorReleaseForSession>>
>;

interface CorrectionProofInput {
  ctx: ToolContext;
  current: MergedSourceInput["current"];
  candidate: DraftReconciliationCandidate;
  originalGrant: DirectProductionGrant;
  predecessorGrant: DirectProductionGrant;
  predecessorAnchor?: MergedSourceInput["reconciliationAnchor"];
  corrected: {
    proposal: ExistingDraftReconciliationProposal;
    selection: Omit<CompiledOperatorReleaseSelection, "publishedSource">;
    schemaChange: SchemaChange;
    originPublicationDigest: string;
  };
  priorMergeSha: string;
}

// oxlint-disable-next-line sonarjs/max-union-size -- Each closed stage identifies an independent proof input without exposing archive contents.
export type OptionalFieldCorrectionProofFailure =
  | "correction-source-scope"
  | "original-draft-preimage"
  | "installed-identity"
  | "merged-predecessor"
  | "original-draft-archive"
  | "corrected-draft-archive"
  | "installed-predecessor-archive"
  | "original-predecessor-marker"
  | "original-predecessor-archive"
  | "correction-equivalence"
  | `correction-equivalence-${OptionalFieldCorrectionFailure}`;

type CorrectionProofResult =
  | { reason: OptionalFieldCorrectionProofFailure }
  | {
      proof: {
        priorMergeSha: string;
        originalReleaseManifestSha256: string;
        installed: ReturnType<typeof releaseIdentity> & { cueSha256: string };
        candidate: ReturnType<typeof releaseIdentity>;
      };
    };

interface CorrectionProofReads {
  readInstalled: typeof readInstalledSchemaPredecessor;
  readMergedSource: typeof readMergedReleaseSourceRecovery;
  readRelease: typeof readExactCompiledOperatorReleaseForSession;
  readMergedGenerated: typeof readMergedGeneratedRelease;
  verify: typeof verifyOptionalFieldCorrectionEquivalence;
}

const readMergedGeneratedRelease = async (input: {
  ctx: ToolContext;
  proposal: ExistingDraftReconciliationProposal;
  priorMergeSha: string;
  installationId: string;
  appId: string;
  releaseId: string;
}): Promise<Awaited<ReturnType<typeof readMergedReleaseSourceRecovery>>> => {
  const { ctx, proposal, priorMergeSha, installationId, appId, releaseId } = input;
  const runtime = await githubPublicationRuntimeForSession(ctx.session.auth, {
    selectedInstallationId: installationId,
  });
  return (
    (await runtime.readMergedAppSchemaRelease?.({
      appId,
      releaseId,
      merged: {
        repositoryId: proposal.repositoryId,
        owner: proposal.owner,
        name: proposal.name,
        baseBranch: proposal.baseBranch,
        sha: priorMergeSha,
      },
    })) ?? null
  );
};

const defaultReads: CorrectionProofReads = {
  readInstalled: readInstalledSchemaPredecessor,
  readMergedSource: readMergedReleaseSourceRecovery,
  readRelease: readExactCompiledOperatorReleaseForSession,
  readMergedGenerated: readMergedGeneratedRelease,
  verify: verifyOptionalFieldCorrectionEquivalence,
};
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const releaseIdentity = ({ selection }: CapturedRelease) => ({
  releaseId: selection.releaseId,
  artifactSha256: selection.schemaSha256,
  manifestSha256: selection.manifestSha256,
});

const readSourceScope = (input: CorrectionProofInput) => {
  const { originalGrant, predecessorGrant, corrected, candidate, current } = input;
  const { subject } = originalGrant;
  const prior = predecessorGrant.subject;
  const { proposal, selection } = corrected;
  const { review } = candidate;
  const originalChange = subject.revision?.schemaChange;
  const predecessorAnchor = input.predecessorAnchor ?? prior.revision?.reconciliation;
  if (review === undefined || originalChange === undefined) {
    return null;
  }
  const generatedOnly =
    originalChange.priorCueSha256 === corrected.schemaChange.priorCueSha256 &&
    originalChange.candidateCueSha256 === corrected.schemaChange.candidateCueSha256;
  if (!generatedOnly && predecessorAnchor === undefined) {
    return null;
  }
  const expected = [
    subject.revision?.priorGrantDigest === predecessorGrant.digest,
    subject.revision?.priorProposalDigest === prior.proposalDigest,
    subject.appId === prior.appId,
    subject.sessionId === prior.sessionId,
    subject.installationId === prior.installationId,
    subject.repositoryId === prior.repositoryId,
    subject.buildWorkspaceId === prior.buildWorkspaceId,
    subject.baseBranch === prior.baseBranch,
    subject.proposalDigest === current.proposal.digest,
    subject.appId === current.appSpec.appId,
    subject.appSpecDigest === current.appSpec.digest,
    subject.repositoryId === current.githubSource?.repository.repositoryId,
    current.githubSource?.resolvedRef === `refs/heads/${subject.baseBranch}`,
    subject.repositoryFullName === `${proposal.owner}/${proposal.name}`,
    subject.baseBranch === proposal.baseBranch,
    subject.repositoryId === proposal.repositoryId,
    subject.appId === selection.appId,
    subject.appSpecDigest === selection.appSpecDigest,
    candidate.appId === subject.appId,
    candidate.repositoryId === proposal.repositoryId,
    candidate.pullRequestNumber === proposal.pullRequestNumber,
    candidate.headSha === proposal.expectedHeadSha,
    candidate.headTree === proposal.expectedHeadTree,
    candidate.baseSha === proposal.expectedBaseSha,
    candidate.baseTree === proposal.expectedBaseTree,
    review.appId === subject.appId,
    review.headSha === proposal.expectedHeadSha,
    review.headTree === proposal.expectedHeadTree,
    review.baseSha === proposal.expectedBaseSha,
    review.baseTree === proposal.expectedBaseTree,
    review.resolvedTree === proposal.resolvedTree,
    review.digest === proposal.reviewDigest,
    digest(JSON.stringify(review.headChanges)) === proposal.headChangesDigest,
    predecessorAnchor?.pullRequestNumber !== proposal.pullRequestNumber,
  ].every(Boolean);
  const originalRepair = subject.revision?.reconciliation;
  const expectedOrigin =
    originalRepair === undefined ||
    [
      originalRepair.originPublicationDigest === corrected.originPublicationDigest,
      originalRepair.originPublicationReceiptDigest === proposal.priorPublicationDigest,
      originalRepair.pullRequestNumber === proposal.pullRequestNumber,
      originalRepair.resolvedTree === proposal.expectedHeadTree,
    ].every(Boolean);
  return expected && expectedOrigin
    ? { subject, review, originalChange, predecessorAnchor, generatedOnly }
    : null;
};

const matchArchivedPrior = (
  archived: CapturedRelease | undefined,
  installed: Predecessor,
  published: NonNullable<Awaited<ReturnType<typeof readMergedReleaseSourceRecovery>>>,
) =>
  archived !== undefined &&
  [
    archived.selection.releaseId === installed.releaseId,
    archived.selection.schemaSha256 === installed.artifactSha256,
    archived.selection.manifestSha256 === installed.manifestSha256,
    GENERATED_RELEASE_MEMBERS.every(
      (member) => digest(archived.files[member]) === published.files[member],
    ),
  ].every(Boolean);

/** Observe evidence only, after release preflight has proved the exact current GitHub heads. */
export const readOptionalFieldCorrectionProof = async (
  input: CorrectionProofInput,
  reads: CorrectionProofReads = defaultReads,
): Promise<CorrectionProofResult> => {
  const { ctx, current, candidate, corrected, priorMergeSha } = input;
  ctx.abortSignal.throwIfAborted();
  const scope = readSourceScope(input);
  if (scope === null) {
    return { reason: "correction-source-scope" };
  }
  const { subject, review, originalChange, predecessorAnchor, generatedOnly } = scope;
  const { appId, appSpecDigest, installationId, repositoryId } = subject;
  const { proposal, selection, schemaChange } = corrected;
  const directory = `apps/${appId}/schema/release/${selection.releaseId}`;
  const draftPreimage = (member: string) =>
    review.headChanges.find(({ path }) => path === `${directory}/${member}`)?.before?.digest;
  const originalArtifact = generatedOnly
    ? selection.schemaSha256
    : draftPreimage("app-artifact.json");
  const originalManifest = draftPreimage("release-manifest.json");
  if (originalArtifact === undefined || originalManifest === undefined) {
    return { reason: "original-draft-preimage" };
  }
  const session = {
    adapterSessionId: ctx.session.id,
    appId,
    appSpecDigest,
    callId: ctx.callId,
    callbackExecution: hostedOperatorCallbackExecution(ctx.session),
    root: candidate.root,
    sessionAuth: ctx.session.auth,
    signal: ctx.abortSignal,
  };
  let installed: Predecessor;
  try {
    installed = await reads.readInstalled(appId, ctx);
  } catch {
    ctx.abortSignal.throwIfAborted();
    return { reason: "installed-identity" };
  }
  const confirmsPrior = [
    installed.appId === appId,
    installed.repositoryId === repositoryId,
    installed.cueSha256 === schemaChange.priorCueSha256,
    generatedOnly || installed.cueSha256 !== originalChange.priorCueSha256,
  ].every(Boolean);
  if (!confirmsPrior) {
    return { reason: "installed-identity" };
  }

  const [publishedRead, originalRead, nextRead, activePriorRead] = await Promise.allSettled([
    generatedOnly
      ? reads.readMergedGenerated({
          ctx,
          proposal,
          priorMergeSha,
          appId,
          installationId,
          releaseId: installed.releaseId,
        })
      : reads.readMergedSource({
          current,
          ctx,
          installationId,
          releaseId: installed.releaseId,
          includeSchemaCue: true,
          includeSchemaCueBytes: true,
          reconciliationAnchor: predecessorAnchor,
        }),
    reads.readRelease({
      ...session,
      lookup: {
        appSpecDigest,
        releaseId: selection.releaseId,
        schemaSha256: originalArtifact,
        manifestSha256: originalManifest,
        publishedSource: {
          repositoryId,
          branch: proposal.branchName,
          gitSha: proposal.expectedHeadSha,
        },
      },
    }),
    reads.readRelease({
      ...session,
      lookup: { appSpecDigest, artifactRef: selection.artifactRef },
    }),
    reads.readRelease({
      ...session,
      lookup: {
        releaseId: installed.releaseId,
        schemaSha256: installed.artifactSha256,
        manifestSha256: installed.manifestSha256,
      },
    }),
  ]);
  ctx.abortSignal.throwIfAborted();
  if (publishedRead.status !== "fulfilled" || publishedRead.value === null) {
    return { reason: "merged-predecessor" };
  }
  if (originalRead.status !== "fulfilled" || originalRead.value === undefined) {
    return { reason: "original-draft-archive" };
  }
  if (nextRead.status !== "fulfilled" || nextRead.value === undefined) {
    return { reason: "corrected-draft-archive" };
  }
  if (activePriorRead.status !== "fulfilled" || activePriorRead.value === undefined) {
    return { reason: "installed-predecessor-archive" };
  }
  const { value: published } = publishedRead;
  const { value: original } = originalRead;
  const { value: next } = nextRead;
  const { value: activePrior } = activePriorRead;
  const priorMatches = [
    published.mergeSha === priorMergeSha,
    published.releaseId === installed.releaseId,
    published.cueSha256 === installed.cueSha256,
  ].every(Boolean);
  if (!priorMatches || published.cueSha256 === undefined) {
    return { reason: "merged-predecessor" };
  }
  if (!matchArchivedPrior(activePrior, installed, published)) {
    return { reason: "installed-predecessor-archive" };
  }
  if (!isEquivalentCompiledOperatorRelease(next.selection, selection)) {
    return { reason: "corrected-draft-archive" };
  }
  const publishedDraft = original.selection.publishedSource;
  const expectedDraft = [
    original.selection.appSpecDigest === appSpecDigest,
    original.selection.releaseId === selection.releaseId,
    original.selection.schemaSha256 === originalArtifact,
    original.selection.manifestSha256 === originalManifest,
    publishedDraft?.repositoryId === repositoryId,
    publishedDraft?.branch === proposal.branchName,
    publishedDraft?.gitSha === proposal.expectedHeadSha,
    publishedDraft?.gitTree === proposal.expectedHeadTree,
  ].every(Boolean);
  if (!expectedDraft) {
    return { reason: "original-draft-archive" };
  }
  let originalPrior: CapturedRelease | undefined;
  if (!generatedOnly) {
    const originalPriorProof = readOptionalTextReleasePredecessor(original.files);
    if (originalPriorProof === null || originalPriorProof.releaseId !== installed.releaseId) {
      return { reason: "original-predecessor-marker" };
    }
    try {
      originalPrior = await reads.readRelease({
        ...session,
        lookup: {
          releaseId: originalPriorProof.releaseId,
          schemaSha256: originalPriorProof.artifactSha256,
        },
      });
    } catch {
      ctx.abortSignal.throwIfAborted();
      return { reason: "original-predecessor-archive" };
    }
    ctx.abortSignal.throwIfAborted();
    if (originalPrior === undefined && published.cueBytes === undefined) {
      return { reason: "original-predecessor-archive" };
    }
  }
  const predecessor = {
    releaseId: installed.releaseId,
    artifactSha256: installed.artifactSha256,
    manifestSha256: installed.manifestSha256,
    cueSha256: installed.cueSha256,
  };
  const approvedPair: Parameters<CorrectionProofReads["verify"]>[0]["original"] = {
    ...originalChange,
    candidate: { ...original.selection, files: original.files },
  };
  if (originalPrior !== undefined) {
    approvedPair.prior = { ...originalPrior.selection, files: originalPrior.files };
  }
  let equivalenceFailure: OptionalFieldCorrectionFailure | undefined;
  const verified = reads.verify(
    {
      appId,
      original: approvedPair,
      corrected: {
        ...schemaChange,
        prior: { ...activePrior.selection, files: activePrior.files },
        candidate: { ...next.selection, files: next.files },
      },
      published: {
        releaseId: published.releaseId,
        artifactSha256: published.files["app-artifact.json"] ?? "",
        manifestSha256: published.files["release-manifest.json"] ?? "",
        cueSha256: published.cueSha256,
      },
      publishedPriorCue: published.cueBytes,
      installed: predecessor,
      headChanges: review.headChanges,
    },
    (reason) => {
      equivalenceFailure = reason;
    },
  );
  return verified
    ? {
        proof: {
          priorMergeSha,
          originalReleaseManifestSha256: originalManifest,
          installed: predecessor,
          candidate: releaseIdentity(next),
        },
      }
    : {
        reason:
          equivalenceFailure === undefined
            ? "correction-equivalence"
            : `correction-equivalence-${equivalenceFailure}`,
      };
};
