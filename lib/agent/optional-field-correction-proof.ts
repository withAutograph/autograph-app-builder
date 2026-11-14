import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";

import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { isEquivalentCompiledOperatorRelease } from "../provisioning/hosted-operator-artifact-selection";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import { verifyOptionalFieldCorrectionEquivalence } from "../provisioning/optional-field-correction-equivalence";
import { readOptionalTextReleasePredecessor } from "../provisioning/repository-production-schema-revision";
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

interface CorrectionProofReads {
  readInstalled: typeof readInstalledSchemaPredecessor;
  readMergedSource: typeof readMergedReleaseSourceRecovery;
  readRelease: typeof readExactCompiledOperatorReleaseForSession;
  verify: typeof verifyOptionalFieldCorrectionEquivalence;
}

const defaultReads: CorrectionProofReads = {
  readInstalled: readInstalledSchemaPredecessor,
  readMergedSource: readMergedReleaseSourceRecovery,
  readRelease: readExactCompiledOperatorReleaseForSession,
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
  if (review === undefined || originalChange === undefined || predecessorAnchor === undefined) {
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
    predecessorAnchor.pullRequestNumber !== proposal.pullRequestNumber,
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
  return expected && expectedOrigin ? { subject, review, originalChange, predecessorAnchor } : null;
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
) => {
  const { ctx, current, candidate, corrected, priorMergeSha } = input;
  ctx.abortSignal.throwIfAborted();
  const scope = readSourceScope(input);
  if (scope === null) {
    return null;
  }
  const { subject, review, originalChange, predecessorAnchor } = scope;
  const { appId, appSpecDigest, installationId, repositoryId } = subject;
  const { proposal, selection, schemaChange } = corrected;
  const directory = `apps/${appId}/schema/release/${selection.releaseId}`;
  const draftPreimage = (member: string) =>
    review.headChanges.find(({ path }) => path === `${directory}/${member}`)?.before?.digest;
  const originalArtifact = draftPreimage("app-artifact.json");
  const originalManifest = draftPreimage("release-manifest.json");
  if (originalArtifact === undefined || originalManifest === undefined) {
    return null;
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
  try {
    const installed = await reads.readInstalled(appId, ctx);
    const confirmsPrior = [
      installed.appId === appId,
      installed.repositoryId === repositoryId,
      installed.cueSha256 === schemaChange.priorCueSha256,
      installed.cueSha256 !== originalChange.priorCueSha256,
    ].every(Boolean);
    if (!confirmsPrior) {
      return null;
    }
    const [published, original, next, activePrior] = await Promise.all([
      reads.readMergedSource({
        current,
        ctx,
        installationId,
        releaseId: installed.releaseId,
        includeSchemaCue: true,
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
    if (published === null || activePrior === undefined) {
      return null;
    }
    if (original === undefined || next === undefined) {
      return null;
    }
    const priorMatches = [
      published.mergeSha === priorMergeSha,
      published.releaseId === installed.releaseId,
      published.cueSha256 === installed.cueSha256,
      matchArchivedPrior(activePrior, installed, published),
    ].every(Boolean);
    if (!priorMatches || published.cueSha256 === undefined) {
      return null;
    }
    if (!isEquivalentCompiledOperatorRelease(next.selection, selection)) {
      return null;
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
      return null;
    }
    const originalPriorProof = readOptionalTextReleasePredecessor(original.files);
    if (originalPriorProof === null || originalPriorProof.releaseId !== installed.releaseId) {
      return null;
    }
    const originalPrior = await reads.readRelease({
      ...session,
      lookup: {
        releaseId: originalPriorProof.releaseId,
        schemaSha256: originalPriorProof.artifactSha256,
      },
    });
    if (originalPrior === undefined) {
      return null;
    }
    ctx.abortSignal.throwIfAborted();
    const predecessor = {
      releaseId: installed.releaseId,
      artifactSha256: installed.artifactSha256,
      manifestSha256: installed.manifestSha256,
      cueSha256: installed.cueSha256,
    };
    const verified = reads.verify({
      appId,
      original: {
        ...originalChange,
        prior: { ...originalPrior.selection, files: originalPrior.files },
        candidate: { ...original.selection, files: original.files },
      },
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
      installed: predecessor,
      headChanges: review.headChanges,
    });
    return verified
      ? {
          priorMergeSha,
          originalReleaseManifestSha256: originalManifest,
          installed: predecessor,
          candidate: releaseIdentity(next),
        }
      : null;
  } catch {
    ctx.abortSignal.throwIfAborted();
    return null;
  }
};
