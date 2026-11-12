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
import { appBuilderWorkflowState } from "./workflow-state";
import { assertApprovedPrivateApplySession } from "./private-apply-authority";

type Context = Pick<WorkflowStepToolContext, "session" | "callId" | "abortSignal">;
export interface GitHubPrDeliveryOwnerSnapshot {
  owner: GitHubPrDeliveryOwnerBinding;
  decision: ApprovedBuildDecision;
}
export type GitHubPrDeliveryOwnerReader = (ctx: Context) => Promise<GitHubPrDeliveryOwnerSnapshot>;
type OwnerBindingReader = (ctx: Context) => Promise<GitHubPrDeliveryOwnerBinding>;
const capturedCallMismatch = "captured-call-mismatch";
type AuthorityFailure =
  | "build-approval-unavailable"
  | "parent-projection-missing"
  | "parent-projection-owner-mismatch"
  | "owner-changed"
  | typeof capturedCallMismatch;
const reportAuthority = (reason: AuthorityFailure) => {
  try {
    console.info(JSON.stringify({ event: "app_builder.github_pr_delivery_authority", reason }));
  } catch {
    // Diagnostic delivery cannot replace the actual approval or ownership outcome.
  }
};
const unavailable = (reason: AuthorityFailure) => {
  reportAuthority(reason);
  return Object.assign(
    new Error("Builder could not verify this delivery call’s current reviewed app and owner."),
    { code: "github_pr_delivery_authority_unavailable", reason },
  );
};

/** Reuse the managed callback owner reader, including committed recovery, membership and Stop. */
const readCanonicalOwner = async (
  ctx: Context,
): Promise<{
  owner: GitHubPrDeliveryOwnerBinding;
  decision: ApprovedBuildDecision | undefined;
}> => {
  ctx.abortSignal.throwIfAborted();
  const localAuthority = await readLocalOperatorArtifactAuthority();
  if (localAuthority !== undefined) {
    const { readLocalBuildDecision } = await import("./local-build-continuation");
    const decision = await readLocalBuildDecision(ctx.session.id);
    return {
      decision,
      owner: {
        kind: "local",
        ownerKey: `local:${localAuthority.ownerUid}:${localAuthority.stateRoot}:${ctx.session.id}`,
        adapterSessionId: ctx.session.id,
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
  return {
    decision: currentSession.privateBuildDecision,
    owner: {
      ownerKey: tenantKeyFor(owner.principal),
      adapterSessionId: currentSession.adapterSessionId,
      adapterGeneration: currentSession.adapterGeneration,
      cancellationRevision: currentSession.cancellationRevision ?? 0,
    },
  };
};

const projectionFailure = (
  snapshot: Awaited<ReturnType<typeof readCanonicalOwner>>,
): "parent-projection-missing" | "parent-projection-owner-mismatch" | undefined => {
  if (snapshot.decision === undefined) {
    return "parent-projection-missing";
  }
  if (snapshot.decision.adapterSessionId !== snapshot.owner.adapterSessionId) {
    return "parent-projection-owner-mismatch";
  }
  return undefined;
};

/** Parent capture authenticates the current owner without borrowing an older call's projection. */
const readCanonicalOwnerBinding: OwnerBindingReader = async (ctx) => {
  const current = await readCanonicalOwner(ctx);
  const prior = projectionFailure(current);
  if (prior !== undefined) {
    reportAuthority(prior);
  }
  return current.owner;
};

/** Child reads still require the durable projection bound to this exact canonical adapter. */
export const readCanonicalGitHubPrDeliveryOwner: GitHubPrDeliveryOwnerReader = async (ctx) => {
  const current = await readCanonicalOwner(ctx);
  const failure = projectionFailure(current);
  if (failure !== undefined || current.decision === undefined) {
    throw unavailable(failure ?? "parent-projection-missing");
  }
  return { owner: current.owner, decision: current.decision };
};

const assertCurrentBuildApproval = (ctx: Context) => {
  const state = appBuilderWorkflowState.get();
  if (!("proposal" in state)) {
    throw unavailable("build-approval-unavailable");
  }
  const scope = {
    appId: state.appSpec.appId,
    appSpecDigest: state.appSpec.digest,
    proposalDigest: state.proposal.digest,
    sessionId: ctx.session.id,
    workspaceId: state.workspace.workspaceId,
  };
  try {
    assertApprovedPrivateApplySession(scope);
  } catch {
    throw unavailable("build-approval-unavailable");
  }
  return scope;
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
    throw unavailable(capturedCallMismatch);
  }
  const projection = parsed.data;
  const call = projection.calls.find((entry) => entry.callId === ctx.callId);
  const subject = projection.current;
  if (call === undefined || subject === null) {
    throw unavailable(capturedCallMismatch);
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
    throw unavailable(capturedCallMismatch);
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
    throw unavailable(capturedCallMismatch);
  }
  if (call.directProductionGrantDigest !== undefined) {
    const grant = decision.directProduction;
    const approved = grant?.subject;
    const matchesRelease = [
      grant?.digest === call.directProductionGrantDigest,
      approved?.appId === spec.appId,
      approved?.appSpecDigest === spec.appSpecDigest,
      approved?.proposalDigest === spec.proposalDigest,
      approved?.buildWorkspaceId === spec.workspaceId,
      approved?.repositoryId === approval.repositoryId,
      approved?.repositoryFullName === `${approval.owner}/${approval.name}`,
      approved?.installationId === approval.installationId,
      approved?.baseBranch === approval.baseBranch,
    ].every(Boolean);
    if (!matchesRelease) {
      throw unavailable(capturedCallMismatch);
    }
  }
  const requirements = [...call.requirements, ...projection.requirements].filter(
    (entry) => entry.appId === subject.appId && entry.repositoryId === approval.repositoryId,
  );
  const authority = { subject, requirements };
  if (call.directProductionGrantDigest === undefined) {
    return authority;
  }
  const direct = { ...authority, directProduction: true as const };
  return decision.directProduction?.subject.revision === undefined
    ? direct
    : { ...direct, productionRevision: true as const };
};

/** Capture scope facts in the parent; this is not a human approval receipt. */
export const captureGitHubPrDeliveryAuthority = async (
  approval: GitHubPrDeliveryApproval,
  ctx: Context,
  ports: {
    readOwnerBinding?: OwnerBindingReader;
    readOwner?: GitHubPrDeliveryOwnerReader;
    persist?: typeof emitCurrentBuildWorkflowProjection;
    directProductionGrantDigest?: string;
  } = {},
) => {
  ctx.abortSignal.throwIfAborted();
  const approvedBuild = assertCurrentBuildApproval(ctx);
  const assertSameBuild = () => {
    if (!isDeepStrictEqual(approvedBuild, assertCurrentBuildApproval(ctx))) {
      throw unavailable(capturedCallMismatch);
    }
  };
  const readOwner = ports.readOwner ?? readCanonicalGitHubPrDeliveryOwner;
  const readOwnerBinding =
    ports.readOwnerBinding ??
    (ports.readOwner === undefined
      ? readCanonicalOwnerBinding
      : async () => {
          const current = await readOwner(ctx);
          return current.owner;
        });
  const before = await readOwnerBinding(ctx);
  ctx.abortSignal.throwIfAborted();
  assertSameBuild();
  captureGitHubPrDeliveryCallScope(
    approval,
    ctx.callId,
    before,
    ctx.session.turn,
    ports.directProductionGrantDigest,
  );
  await (ports.persist ?? emitCurrentBuildWorkflowProjection)(ctx);
  const after = await readOwner(ctx);
  ctx.abortSignal.throwIfAborted();
  assertSameBuild();
  if (!isDeepStrictEqual(before, after.owner)) {
    throw unavailable("owner-changed");
  }
  await readGitHubPrDeliveryAuthority(approval, ctx, async () => await Promise.resolve(after));
};
