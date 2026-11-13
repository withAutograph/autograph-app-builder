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
import type { GitHubDeliveryEffectRejection } from "./native-recovery-github-delivery-effects";

const deliveryTool = "finish-github-pr-delivery";
const id = z.string().min(1);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const completedStepSchema = z.strictObject({
  name: id,
  args: z.unknown(),
  output: z.unknown(),
  status: z.enum(["completed", "failed", "cancelled"]).optional(),
  afterStop: z.literal(true).optional(),
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

export type CancelledGitHubDeliveryRefusal =
  | "approval_shape"
  | "reviewed_state_shape"
  | "capture_shape"
  | "grant_shape"
  | "native_identity"
  | "current_capture_missing"
  | "current_capture_mismatch"
  | "current_review_mismatch"
  | "revision_anchor_mismatch"
  | "prior_reader_unavailable"
  | "repeat_effects_unproven"
  | `effect_${GitHubDeliveryEffectRejection}`
  | "prior_capture_missing"
  | "prior_capture_mismatch"
  | "prior_epoch_mismatch"
  | "prior_history_unavailable"
  | "prior_history_missing"
  | "prior_input_shape"
  | "prior_result_shape"
  | "prior_target_mismatch"
  | "prior_result_not_live"
  | "receipt_unavailable"
  | "receipt_missing"
  | "receipt_shape"
  | "receipt_mismatch";

const unavailableEvidence = (boundary: CancelledGitHubDeliveryRefusal) => ({
  kind: "refused" as const,
  boundary,
});

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
  const parsedContext = serializedContextSchema.safeParse(witness.serializedContext);
  const authority = hostedTenantAuthoritySchema.safeParse({
    issuer: owner.issuer,
    audience: owner.audience,
    workspaceId: owner.workspaceId,
    ownerUserId: owner.ownerUserId,
  }).data;
  if (approval === undefined) {
    return unavailableEvidence("approval_shape");
  }
  if (!parsedContext.success) {
    const key = parsedContext.error.issues[0]?.path[0];
    if (key === "autograph-app-builder.github-pr-delivery-call-scopes.v1") {
      return unavailableEvidence("capture_shape");
    }
    if (key === "autograph-app-builder.direct-production-authorization.v1") {
      return unavailableEvidence("grant_shape");
    }
    return unavailableEvidence("reviewed_state_shape");
  }
  const { data: context } = parsedContext;
  const matchesNativeIdentity = [
    authority !== undefined,
    witness.toolName === deliveryTool,
    approval.reconciliationDigest === undefined,
    context["eve.sessionId"] === witness.logicalSessionId,
    approval.sessionId === undefined || approval.sessionId === witness.logicalSessionId,
    Number.isSafeInteger(witness.turnSequence),
    witness.turnSequence >= 0,
    witness.checkpointOwnerRunId.length > 0,
  ].every(Boolean);
  if (!matchesNativeIdentity) {
    return unavailableEvidence("native_identity");
  }

  const calls = context["autograph-app-builder.github-pr-delivery-call-scopes.v1"].filter(
    (entry) => entry.callId === witness.callId,
  );
  const [call] = calls;
  if (calls.length !== 1 || call === undefined || "kind" in call.owner) {
    return unavailableEvidence("current_capture_missing");
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
    return unavailableEvidence("current_capture_mismatch");
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
    return unavailableEvidence("current_review_mismatch");
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
      return unavailableEvidence("revision_anchor_mismatch");
    }
  }

  return {
    kind: "verified" as const,
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
  return evidence.kind === "verified" && hasSettledGitHubDeliveryEffects(evidence.effects);
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
  onRefusal?: (boundary: CancelledGitHubDeliveryRefusal) => void,
): Promise<boolean> => {
  const refuse = (boundary: CancelledGitHubDeliveryRefusal): false => {
    try {
      onRefusal?.(boundary);
    } catch {
      // Diagnostic delivery cannot change the verifier's result.
    }
    return false;
  };
  const evidence = readDeliveryEvidence(witness, owner);
  if (evidence.kind === "refused") {
    return refuse(evidence.boundary);
  }
  let effectRefusal: GitHubDeliveryEffectRejection | undefined;
  const retainEffectRefusal = (reason: GitHubDeliveryEffectRejection) => {
    effectRefusal = reason;
  };
  if (hasSettledGitHubDeliveryEffects(evidence.effects, retainEffectRefusal)) {
    return true;
  }
  if (witness.readCommittedDelivery === undefined || readPriorMergeReceipt === undefined) {
    return refuse("prior_reader_unavailable");
  }
  const proof = priorMergeProofSchema.safeParse(
    readSettledGitHubDeliveryRepeat(evidence.effects, retainEffectRefusal),
  ).data;
  if (proof === undefined || proof.deliveryCallId === witness.callId) {
    return refuse(
      effectRefusal === undefined ? "repeat_effects_unproven" : `effect_${effectRefusal}`,
    );
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
    return refuse("prior_capture_missing");
  }
  const sameReviewedScope = [
    original.cancelled !== true,
    original.owner.ownerKey === call.owner.ownerKey,
    original.owner.adapterSessionId === call.owner.adapterSessionId,
    original.owner.adapterGeneration === call.owner.adapterGeneration,
    isDeepStrictEqual(original.subject, call.subject),
    original.directProductionGrantDigest === call.directProductionGrantDigest,
  ].every(Boolean);
  if (!sameReviewedScope) {
    return refuse("prior_capture_mismatch");
  }
  if (
    original.owner.cancellationRevision >= call.owner.cancellationRevision ||
    original.turnSequence >= call.turnSequence ||
    original.turnId === call.turnId
  ) {
    return refuse("prior_epoch_mismatch");
  }

  let committed: ReturnType<NonNullable<CancelledGitHubDeliveryWitness["readCommittedDelivery"]>>;
  try {
    committed = witness.readCommittedDelivery(proof.deliveryCallId);
  } catch {
    return refuse("prior_history_unavailable");
  }
  if (committed === undefined) {
    return refuse("prior_history_missing");
  }
  const previousApproval = githubPrDeliveryApprovalSchema.safeParse(committed.toolInput).data;
  const previousResult = committedDeliverySchema.safeParse(committed.result).data;
  if (previousApproval === undefined) {
    return refuse("prior_input_shape");
  }
  if (previousResult === undefined) {
    return refuse("prior_result_shape");
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
  ].every(Boolean);
  if (!matchesOriginal) {
    return refuse("prior_target_mismatch");
  }
  if (
    nativeProduction.status !== "available" ||
    nativeProduction.requestedRevision !== "live" ||
    nativeProduction.deployment.requestedRevisionActive !== undefined
  ) {
    return refuse("prior_result_not_live");
  }
  let rawReceipt: GitHubPrEffectReceipt | undefined;
  try {
    rawReceipt = await readPriorMergeReceipt(proof.mergeIntentDigest);
  } catch {
    return refuse("receipt_unavailable");
  }
  if (rawReceipt === undefined) {
    return refuse("receipt_missing");
  }
  let receipt: GitHubPrEffectReceipt;
  try {
    receipt = parseGitHubPrEffectReceipt(rawReceipt);
  } catch {
    return refuse("receipt_shape");
  }
  if (
    receipt.status !== "succeeded" ||
    receipt.intent.kind !== "pr-merge" ||
    receipt.evidence.kind !== "pr-merge"
  ) {
    return refuse("receipt_shape");
  }
  const { intent } = receipt;
  const matchesReceipt = [
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
  return matchesReceipt || refuse("receipt_mismatch");
};
