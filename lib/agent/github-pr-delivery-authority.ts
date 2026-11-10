import { tenantKeyFor } from "../eve/hosted-auth";
import type { WorkflowStepToolContext } from "eve/tools";
import { isDeepStrictEqual } from "node:util";
import type { ApprovedBuildDecision } from "./approved-build-continuation";
import {
  continuationOwnerStore,
  emitCurrentBuildWorkflowProjection,
} from "./approved-build-continuation-runtime";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import {
  hostedOperatorCallbackExecution,
  readHostedOperatorCallbackOwner,
} from "../provisioning/hosted-operator-callback-owner";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import {
  captureGitHubPrDeliveryCallScope,
  githubPrDeliveryInputDigest,
} from "./github-pr-delivery-authority-state";
import { githubPrDeliveryAuthorityProjectionSchema } from "./github-pr-delivery-authority-contract";
import type { GitHubPrDeliveryOwnerBinding } from "./github-pr-delivery-authority-contract";

type Context = Pick<WorkflowStepToolContext, "session" | "callId" | "abortSignal">;
export interface GitHubPrDeliveryOwnerSnapshot {
  owner: GitHubPrDeliveryOwnerBinding;
  decision: ApprovedBuildDecision;
}
export type GitHubPrDeliveryOwnerReader = (ctx: Context) => Promise<GitHubPrDeliveryOwnerSnapshot>;
const unavailable = () =>
  new Error("Builder could not verify this delivery call’s current reviewed app and owner.");

/** Reuse the managed callback owner reader, including committed recovery, membership and Stop. */
export const readCanonicalGitHubPrDeliveryOwner: GitHubPrDeliveryOwnerReader = async (ctx) => {
  ctx.abortSignal.throwIfAborted();
  const localAuthority = await readLocalOperatorArtifactAuthority();
  if (localAuthority !== undefined) {
    const { readLocalBuildDecision } = await import("./local-build-continuation");
    const decision = await readLocalBuildDecision(ctx.session.id);
    if (decision === undefined) {
      throw unavailable();
    }
    return {
      decision,
      owner: {
        kind: "local",
        ownerKey: `local:${localAuthority.ownerUid}:${localAuthority.stateRoot}:${ctx.session.id}`,
        adapterSessionId: decision.adapterSessionId,
      },
    };
  }
  const { owner, store } = await continuationOwnerStore(ctx);
  const { currentSession } = await readHostedOperatorCallbackOwner({
    store,
    owner,
    execution: hostedOperatorCallbackExecution(ctx.session),
  });
  ctx.abortSignal.throwIfAborted();
  const decision = currentSession.privateBuildDecision;
  if (decision === undefined || decision.adapterSessionId !== currentSession.adapterSessionId) {
    throw unavailable();
  }
  return {
    decision,
    owner: {
      ownerKey: tenantKeyFor(owner.principal),
      adapterSessionId: currentSession.adapterSessionId,
      adapterGeneration: currentSession.adapterGeneration,
      cancellationRevision: currentSession.cancellationRevision ?? 0,
    },
  };
};

/** Capture scope facts in the parent; this is not a human approval receipt. */
export const captureGitHubPrDeliveryAuthority = async (
  approval: GitHubPrDeliveryApproval,
  ctx: Context,
  ports: {
    readOwner?: GitHubPrDeliveryOwnerReader;
    persist?: typeof emitCurrentBuildWorkflowProjection;
  } = {},
) => {
  const readOwner = ports.readOwner ?? readCanonicalGitHubPrDeliveryOwner;
  const before = await readOwner(ctx);
  ctx.abortSignal.throwIfAborted();
  captureGitHubPrDeliveryCallScope(approval, ctx.callId, before.owner, ctx.session.turn);
  await (ports.persist ?? emitCurrentBuildWorkflowProjection)(ctx);
  const after = await readOwner(ctx);
  ctx.abortSignal.throwIfAborted();
  if (!isDeepStrictEqual(before.owner, after.owner)) {
    throw unavailable();
  }
};

/** Child wakes read canonical parent facts; they never read child-local Builder defineState. */
export const readGitHubPrDeliveryAuthority = async (
  approval: GitHubPrDeliveryApproval,
  ctx: Context,
  readOwner: GitHubPrDeliveryOwnerReader = readCanonicalGitHubPrDeliveryOwner,
) => {
  const { decision, owner } = await readOwner(ctx);
  ctx.abortSignal.throwIfAborted();
  const parsed = githubPrDeliveryAuthorityProjectionSchema.safeParse(decision.githubDelivery);
  if (!parsed.success) {
    throw unavailable();
  }
  const projection = parsed.data;
  const call = projection.calls.find((entry) => entry.callId === ctx.callId);
  const subject = projection.current;
  if (call === undefined || subject === null) {
    throw unavailable();
  }
  const sameCall = [
    call.cancelled !== true,
    call.turnId === ctx.session.turn.id,
    call.turnSequence === ctx.session.turn.sequence,
    isDeepStrictEqual(call.owner, owner),
    call.inputDigest === githubPrDeliveryInputDigest(approval),
    isDeepStrictEqual(call.subject, subject),
  ].every(Boolean);
  const spec = decision.currentSpec;
  if (spec === undefined) {
    throw unavailable();
  }
  const sameSubject = [
    spec.appId === subject.appId,
    spec.appSpecDigest === subject.appSpecDigest,
    spec.sessionId === ctx.session.id,
    subject.proposalDigest === approval.proposalDigest,
    subject.installationId === approval.installationId,
    subject.reconciliationDigest === approval.reconciliationDigest,
  ].every(Boolean);
  if (!sameCall || !sameSubject) {
    throw unavailable();
  }
  const requirements = [...call.requirements, ...projection.requirements].filter(
    (entry) => entry.appId === subject.appId && entry.repositoryId === approval.repositoryId,
  );
  return { subject, requirements };
};
