import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { defineState } from "eve/context";
import { canonical } from "../eve/hosted-operation-identifiers";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import {
  githubPrDeliveryAuthorityProjectionSchema,
  githubPrDeliveryReviewScopeSchema,
} from "./github-pr-delivery-authority-contract";
import type {
  GitHubPrDeliveryAuthorityProjection,
  GitHubPrDeliveryCallScope,
  GitHubPrDeliveryOwnerBinding,
} from "./github-pr-delivery-authority-contract";
import { appBuilderWorkflowState } from "./workflow-state";
import { draftReconciliationState } from "./draft-reconciliation-state";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import { resolveGitHubPrDeliverySubject } from "./github-pr-delivery-subject";
import { managedProductionDeliveryRequirements } from "./production-delivery-requirement";

const calls = defineState<GitHubPrDeliveryCallScope[]>(
  "autograph-app-builder.github-pr-delivery-call-scopes.v1",
  () => [],
);
const published = defineState<GitHubPrDeliveryAuthorityProjection | null>(
  "autograph-app-builder.github-pr-delivery-projected-scope.v1",
  () => null,
);
export const githubPrDeliveryInputDigest = (input: GitHubPrDeliveryApproval) =>
  createHash("sha256")
    .update("autograph/github-pr-delivery-input/v1\n")
    .update(canonical(input))
    .digest("hex");

/** Called in the ordinary parent context only; never used as a child state getter. */
export const currentGitHubPrDeliveryAuthorityProjection =
  (): GitHubPrDeliveryAuthorityProjection => {
    const workflow = appBuilderWorkflowState.get();
    const candidate = draftReconciliationState.get();
    const reviewed = resolveDraftReviewedWorkflow(workflow, candidate);
    const subject = resolveGitHubPrDeliverySubject(workflow, candidate);
    const current =
      reviewed === undefined || subject === undefined
        ? null
        : githubPrDeliveryReviewScopeSchema.safeParse({
            appId: subject.appId,
            appSpecDigest: reviewed.appSpec.digest,
            reviewDigest: reviewed.reviewReceipt?.digest,
            proposalDigest: subject.proposalDigest,
            installationId: subject.installationId,
            reconciliationDigest: subject.reconciliation?.digest,
          });
    return githubPrDeliveryAuthorityProjectionSchema.parse({
      version: 1,
      current: current !== null && current.success ? current.data : null,
      requirements: managedProductionDeliveryRequirements.get(),
      calls: calls.get(),
    });
  };
export const gitHubPrDeliveryAuthorityProjectionChanged = () => {
  const projection = currentGitHubPrDeliveryAuthorityProjection();
  if (
    published.get() === null &&
    projection.current === null &&
    projection.calls.length === 0 &&
    projection.requirements.length === 0
  ) {
    return false;
  }
  return !isDeepStrictEqual(projection, published.get());
};
export const markGitHubPrDeliveryAuthorityProjected = (
  projection: GitHubPrDeliveryAuthorityProjection,
) => {
  published.update(() => projection);
};

export const captureGitHubPrDeliveryCallScope = (
  input: GitHubPrDeliveryApproval,
  callId: string,
  owner: GitHubPrDeliveryOwnerBinding,
  turn: { id: string; sequence: number },
  directProductionGrantDigest?: string,
) => {
  const projection = currentGitHubPrDeliveryAuthorityProjection();
  const subject = projection.current;
  if (
    subject === null ||
    subject.proposalDigest !== input.proposalDigest ||
    subject.installationId !== input.installationId ||
    subject.reconciliationDigest !== input.reconciliationDigest
  ) {
    throw new Error("The delivery approval no longer belongs to the current reviewed app.");
  }
  const capture: GitHubPrDeliveryCallScope = {
    owner,
    callId,
    turnId: turn.id,
    turnSequence: turn.sequence,
    inputDigest: githubPrDeliveryInputDigest(input),
    subject,
    requirements: projection.requirements.filter(
      (entry) => entry.appId === subject.appId && entry.repositoryId === input.repositoryId,
    ),
  };
  if (directProductionGrantDigest !== undefined) {
    capture.directProductionGrantDigest = directProductionGrantDigest;
  }
  const previous = calls.get().find((entry) => entry.callId === callId);
  if (
    previous !== undefined &&
    ![
      previous.cancelled !== true,
      previous.turnId === turn.id,
      previous.turnSequence === turn.sequence,
      isDeepStrictEqual(previous.owner, capture.owner),
      previous.inputDigest === capture.inputDigest,
      previous.directProductionGrantDigest === capture.directProductionGrantDigest,
      isDeepStrictEqual(previous.subject, capture.subject),
    ].every(Boolean)
  ) {
    throw new Error("The delivery call no longer matches its original reviewed scope.");
  }
  if (previous === undefined) {
    calls.update((current) => [...current, capture]);
  }
  return capture;
};

/** A native cancelled turn retires only its own delivery calls; failures and prose never do. */
export const invalidateGitHubPrDeliveryCallsForTurn = (turnId: string) => {
  calls.update((current) =>
    current.map((call) => (call.turnId === turnId ? { ...call, cancelled: true } : call)),
  );
};
