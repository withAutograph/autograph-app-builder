import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { directProductionGrantSchema } from "../agent/direct-production-authorization";
import { githubPrDeliveryApprovalSchema } from "../agent/github-pr-delivery-approval";
import { githubPrDeliveryCallScopeSchema } from "../agent/github-pr-delivery-authority-contract";
import { githubPrDeliveryInputDigest } from "../agent/github-pr-delivery-authority-state";
import { APP_BUILDER_WORKFLOW_STATE_KEY } from "../agent/workflow-state";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  repositoryProductionExpectedMergeShaSchema,
  repositoryProductionNativeStatusSchema,
} from "../provisioning/repository-production-native-status-contract";
import { parseGitHubPrEffectReceipt } from "../repository/github-pr-effect-journal";
import type { GitHubPrEffectReceipt } from "../repository/github-pr-effect-journal";
import { tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  hasSettledGitHubDeliveryEffects,
  readSettledGitHubDeliveryRepeat,
} from "./native-recovery-github-delivery-effects";

const deliveryTool = "finish-github-pr-delivery";
const id = z.string().min(1);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const completedStepSchema = z.strictObject({
  name: id,
  args: z.unknown(),
  output: z.unknown(),
  status: z.enum(["completed", "failed", "cancelled"]).optional(),
});
const committedDeliverySchema = z.strictObject({
  status: z.literal("merged"),
  mergeCommitSha: repositoryProductionExpectedMergeShaSchema,
  nativeProduction: repositoryProductionNativeStatusSchema,
  schemaUpdatePending: z.literal(false).optional(),
});
const priorMergeProofSchema = z.strictObject({
  deliveryCallId: id,
  mergeIntentDigest: digest,
  mergeSha: repositoryProductionExpectedMergeShaSchema,
  readyAt: z.iso.datetime({ offset: true }).optional(),
});
const reviewedStateSchema = z.object({
  phase: z.literal("reviewed"),
  appSpec: z.object({ appId: id, digest }),
  proposal: z.object({ digest }),
  workspace: z.object({ workspaceId: id }),
  reviewReceipt: z.object({ digest }),
  publishedGitHubDraftProposalDigest: digest.optional(),
  githubDraftProposal: z
    .object({ proposal: z.object({ digest, reviewDigest: digest }) })
    .optional(),
});
const serializedContextSchema = z.object({
  "eve.sessionId": id,
  [APP_BUILDER_WORKFLOW_STATE_KEY]: reviewedStateSchema,
  "autograph-app-builder.github-pr-delivery-call-scopes.v1": z.array(
    githubPrDeliveryCallScopeSchema,
  ),
  "autograph-app-builder.direct-production-authorization.v1": z.object({
    grant: directProductionGrantSchema,
    revisionAnchor: z
      .object({ proposalDigest: digest, priorGrant: directProductionGrantSchema })
      .optional(),
  }),
});

export interface CancelledGitHubDeliveryWitness {
  readonly toolName: string;
  readonly callId: string;
  readonly turnId: string;
  readonly turnSequence: number;
  readonly logicalSessionId: string;
  readonly checkpointOwnerRunId: string;
  readonly toolInput: unknown;
  readonly serializedContext: unknown;
  readonly completedSteps: readonly z.input<typeof completedStepSchema>[];
  readonly readCommittedDelivery?: (
    callId: string,
  ) => { toolInput: unknown; result: unknown } | undefined;
}

export type PriorMergeReceiptReader = (
  digest: string,
) => Promise<GitHubPrEffectReceipt | undefined>;
export type CancelledGitHubDeliveryOwner = HostedPrincipal & {
  readonly sourceOwnerRunId: string;
  readonly sourceAdapterGeneration: number;
  readonly parentCancellationRevision: number;
};

const matchesCurrentDestination = (
  prior: z.infer<typeof directProductionGrantSchema>["subject"],
  current: z.infer<typeof directProductionGrantSchema>["subject"],
): boolean =>
  [
    prior.sessionId === current.sessionId,
    prior.appId === current.appId,
    prior.repositoryId === current.repositoryId,
    prior.repositoryFullName === current.repositoryFullName,
    prior.installationId === current.installationId,
    prior.baseBranch === current.baseBranch,
    prior.storageKind === current.storageKind,
    isDeepStrictEqual(prior.authority, current.authority),
  ].every(Boolean);

const readDeliveryEvidence = (
  witness: CancelledGitHubDeliveryWitness,
  owner: CancelledGitHubDeliveryOwner,
) => {
  const approval = githubPrDeliveryApprovalSchema.safeParse(witness.toolInput).data;
  const context = serializedContextSchema.safeParse(witness.serializedContext).data;
  const authority = hostedTenantAuthoritySchema.safeParse({
    issuer: owner.issuer,
    audience: owner.audience,
    workspaceId: owner.workspaceId,
    ownerUserId: owner.ownerUserId,
  }).data;
  if (approval === undefined || context === undefined || authority === undefined) {
    return null;
  }
  const matchesNativeIdentity = [
    witness.toolName === deliveryTool,
    approval.reconciliationDigest === undefined,
    context["eve.sessionId"] === witness.logicalSessionId,
    approval.sessionId === undefined || approval.sessionId === witness.logicalSessionId,
    Number.isSafeInteger(witness.turnSequence),
    witness.turnSequence >= 0,
    witness.checkpointOwnerRunId.length > 0,
  ].every(Boolean);
  if (!matchesNativeIdentity) {
    return null;
  }

  const calls = context["autograph-app-builder.github-pr-delivery-call-scopes.v1"].filter(
    (entry) => entry.callId === witness.callId,
  );
  const [call] = calls;
  if (calls.length !== 1 || call === undefined || "kind" in call.owner) {
    return null;
  }
  const matchesCapturedCall = [
    call.owner.ownerKey === tenantKeyFor(owner),
    call.owner.adapterSessionId === owner.sourceOwnerRunId,
    call.owner.adapterGeneration === owner.sourceAdapterGeneration,
    call.owner.cancellationRevision <= owner.parentCancellationRevision,
    call.turnId === witness.turnId,
    call.turnSequence === witness.turnSequence,
    call.inputDigest === githubPrDeliveryInputDigest(approval),
  ].every(Boolean);
  if (!matchesCapturedCall) {
    return null;
  }

  const workflow = context[APP_BUILDER_WORKFLOW_STATE_KEY];
  const { grant, revisionAnchor } =
    context["autograph-app-builder.direct-production-authorization.v1"];
  const { subject } = grant;
  const { reviewReceipt, githubDraftProposal } = workflow;
  const sealedProposal = githubDraftProposal?.proposal;
  const publicationDigest = workflow.publishedGitHubDraftProposalDigest ?? sealedProposal?.digest;
  const retainedReviewMatches =
    sealedProposal === undefined ||
    (sealedProposal.digest === publicationDigest &&
      sealedProposal.reviewDigest === reviewReceipt.digest);
  const bindingsMatch = [
    retainedReviewMatches,
    call.subject.reconciliationDigest === undefined,
    call.subject.reviewDigest === reviewReceipt.digest,
    call.subject.proposalDigest === publicationDigest,
    call.subject.proposalDigest === approval.proposalDigest,
    call.subject.installationId === approval.installationId,
    call.subject.appId === workflow.appSpec.appId,
    call.subject.appSpecDigest === workflow.appSpec.digest,
    call.directProductionGrantDigest === grant.digest,
    subject.appId === workflow.appSpec.appId,
    subject.appSpecDigest === workflow.appSpec.digest,
    subject.proposalDigest === workflow.proposal.digest,
    subject.buildWorkspaceId === workflow.workspace.workspaceId,
    subject.sessionId === witness.logicalSessionId,
    subject.repositoryId === approval.repositoryId,
    subject.repositoryFullName === `${approval.owner}/${approval.name}`,
    subject.installationId === approval.installationId,
    subject.baseBranch === approval.baseBranch,
    isDeepStrictEqual(subject.authority, authority),
  ].every(Boolean);
  if (!bindingsMatch) {
    return null;
  }

  const { revision } = subject;
  if (revision !== undefined) {
    const matchesPredecessor =
      revisionAnchor !== undefined &&
      [
        revisionAnchor.proposalDigest === subject.proposalDigest,
        revisionAnchor.priorGrant.digest === revision.priorGrantDigest,
        revisionAnchor.priorGrant.subject.proposalDigest === revision.priorProposalDigest,
        revision.priorProposalDigest !== subject.proposalDigest,
        matchesCurrentDestination(revisionAnchor.priorGrant.subject, subject),
      ].every(Boolean);
    if (!matchesPredecessor) {
      return null;
    }
  }

  return {
    approval,
    call,
    context,
    effects: {
      callId: witness.callId,
      logicalSessionId: witness.logicalSessionId,
      appId: subject.appId,
      toolInput: approval,
      schemaChangeExpected: revision?.schemaChange !== undefined,
      completedSteps: witness.completedSteps,
    },
  };
};

/** Retained write authority is historical evidence and never authorizes another call. */
export const verifySettledGitHubDelivery = (
  witness: CancelledGitHubDeliveryWitness,
  owner: CancelledGitHubDeliveryOwner,
): boolean => {
  const evidence = readDeliveryEvidence(witness, owner);
  return evidence !== null && hasSettledGitHubDeliveryEffects(evidence.effects);
};

const sameTarget = (
  current: z.infer<typeof githubPrDeliveryApprovalSchema>,
  previous: z.infer<typeof githubPrDeliveryApprovalSchema>,
) =>
  (
    [
      "repositoryId",
      "owner",
      "name",
      "baseBranch",
      "headSha",
      "pullRequestNumber",
      "proposalDigest",
      "installationId",
      "reconciliationDigest",
    ] as const
  ).every((key) => current[key] === previous[key]);

/** A stopped repeat can rely on an earlier exact completed delivery without replaying it. */
export const verifySettledGitHubDeliveryWithPriorReceipt = async (
  witness: CancelledGitHubDeliveryWitness,
  owner: CancelledGitHubDeliveryOwner,
  readPriorMergeReceipt?: PriorMergeReceiptReader,
): Promise<boolean> => {
  const evidence = readDeliveryEvidence(witness, owner);
  if (evidence === null) {
    return false;
  }
  if (hasSettledGitHubDeliveryEffects(evidence.effects)) {
    return true;
  }
  if (witness.readCommittedDelivery === undefined || readPriorMergeReceipt === undefined) {
    return false;
  }
  const proof = priorMergeProofSchema.safeParse(
    readSettledGitHubDeliveryRepeat(evidence.effects),
  ).data;
  if (proof === undefined || proof.deliveryCallId === witness.callId) {
    return false;
  }

  const { approval, call, context } = evidence;
  const earlier = context["autograph-app-builder.github-pr-delivery-call-scopes.v1"].filter(
    (entry) => entry.callId === proof.deliveryCallId,
  );
  const [original] = earlier;
  if (
    earlier.length !== 1 ||
    original === undefined ||
    "kind" in original.owner ||
    "kind" in call.owner
  ) {
    return false;
  }
  const sameReviewedScope = [
    original.cancelled !== true,
    original.owner.ownerKey === call.owner.ownerKey,
    original.owner.adapterSessionId === call.owner.adapterSessionId,
    original.owner.adapterGeneration === call.owner.adapterGeneration,
    original.owner.cancellationRevision < call.owner.cancellationRevision,
    original.turnSequence < call.turnSequence,
    original.turnId !== call.turnId,
    isDeepStrictEqual(original.subject, call.subject),
    original.directProductionGrantDigest === call.directProductionGrantDigest,
  ].every(Boolean);
  if (!sameReviewedScope) {
    return false;
  }

  const committed = witness.readCommittedDelivery(proof.deliveryCallId);
  const previousApproval = githubPrDeliveryApprovalSchema.safeParse(committed?.toolInput).data;
  const previousResult = committedDeliverySchema.safeParse(committed?.result).data;
  if (previousApproval === undefined || previousResult === undefined) {
    return false;
  }
  const { nativeProduction } = previousResult;
  const matchesOriginal = [
    sameTarget(approval, previousApproval),
    previousApproval.sessionId === undefined ||
      previousApproval.sessionId === witness.logicalSessionId,
    original.inputDigest === githubPrDeliveryInputDigest(previousApproval),
    previousResult.mergeCommitSha === proof.mergeSha,
    nativeProduction.appId === call.subject.appId,
    nativeProduction.destination?.repositoryId === approval.repositoryId,
    nativeProduction.destination?.repositoryFullName === `${approval.owner}/${approval.name}`,
    nativeProduction.status === "available",
    nativeProduction.requestedRevision === "live",
    nativeProduction.deployment.requestedRevisionActive === undefined,
  ].every(Boolean);
  if (!matchesOriginal) {
    return false;
  }

  try {
    const receipt = parseGitHubPrEffectReceipt(
      await readPriorMergeReceipt(proof.mergeIntentDigest),
    );
    if (
      receipt.status !== "succeeded" ||
      receipt.intent.kind !== "pr-merge" ||
      receipt.evidence.kind !== "pr-merge"
    ) {
      return false;
    }
    const { intent } = receipt;
    return [
      receipt.intentDigest === proof.mergeIntentDigest,
      receipt.approvedByCallId === original.callId,
      receipt.evidence.mergeCommitSha === proof.mergeSha,
      intent.publicationDigest === approval.proposalDigest,
      intent.repositoryId === approval.repositoryId,
      intent.owner === approval.owner,
      intent.name === approval.name,
      intent.baseBranch === approval.baseBranch,
      intent.headSha === approval.headSha,
      intent.pullRequestNumber === approval.pullRequestNumber,
      [approval.readyAt, previousApproval.readyAt, proof.readyAt].every(
        (cycle) => cycle === undefined || cycle === intent.readyAt,
      ),
    ].every(Boolean);
  } catch {
    return false;
  }
};
