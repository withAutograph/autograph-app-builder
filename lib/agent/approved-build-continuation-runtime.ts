import {
  currentGitHubPrDeliveryAuthorityProjection,
  markGitHubPrDeliveryAuthorityProjected,
} from "./github-pr-delivery-authority-state";
import { currentLocalSourcePrerequisite } from "./local-source-prerequisite-state";
import { repositoryAccessReceiptState } from "./repository-access-state";

import { defineState } from "eve/context";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { hasTestCapability } from "../testing/test-capability";
import type { HookContext } from "eve/hooks";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import {
  approvedBuildDecisionSchema,
  approvedBuildProgress,
  readInternalBuildMarker,
} from "./approved-build-continuation";
import type { ApprovedBuildDecision } from "./approved-build-continuation";
import type { HostedEveStore } from "../eve/hosted-store";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { appBuilderWorkflowState } from "./workflow-state";

export const authenticatedBuildDelivery = defineState<{ turnId: string; progress: string } | null>(
  "autograph-app-builder.authenticated-build-delivery.v1",
  () => null,
);
export const approvedBuildReviewProgress = defineState<{
  buildProgress: string;
  stage: "prepared" | "assessed";
} | null>("autograph-app-builder.approved-build-review-progress.v1", () => null);

export const currentApprovedBuildProgress = (): string => {
  const build = approvedBuildProgress(appBuilderWorkflowState.get());
  const review = approvedBuildReviewProgress.get();
  return review?.buildProgress === build ? `${build}:${review.stage}` : build;
};

/** Structural evaluations retain their actual private Eve projection without claiming a public hosted session. */
export const diagnosticBuildDecisionState = defineState<ApprovedBuildDecision | null>(
  "autograph-app-builder.diagnostic-build-decision.v1",
  () => null,
);

// oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Authenticate the current owner before opening its private persistence adapter.
export const continuationOwnerStore = async (ctx: Pick<HookContext, "session">) => {
  const { authority, principal } = exactForwardedSessionAuthority(ctx.session.auth);
  const { resolveHostedOperatorOwnerContext } =
    await import("../provisioning/hosted-operator-owner-context");
  const owner = await resolveHostedOperatorOwnerContext({
    adapterSessionId: ctx.session.id,
    authority,
    environment: process.env,
    principal,
    sessionAuth: ctx.session.auth,
    execution: hostedOperatorCallbackExecution(ctx.session),
  });
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Establish current owner authority before opening the private persistence adapter.
  const [
    { openHostedPostgresDatabase },
    { readPreviewOAuthRuntimeConfig },
    { createPostgresHostedEveStore },
  ] = await Promise.all([
    import("../mcp/hosted-route"),
    import("../auth/preview-oauth-runtime"),
    import("../eve/postgres-hosted-store"),
  ]);
  const config = readPreviewOAuthRuntimeConfig({ ...process.env });
  const store = createPostgresHostedEveStore(openHostedPostgresDatabase(config.databaseUrl));
  return { owner, principal, store };
};

/** The store binds the logical owner's projection to the exact committed current child. */
export const persistHostedBuildDecision = async (input: {
  decision: ApprovedBuildDecision;
  ownerSessionId: string;
  principal: HostedPrincipal;
  store: HostedEveStore;
}): Promise<void> => {
  await input.store.recordPrivateBuildDecision?.({
    decision: approvedBuildDecisionSchema.parse(input.decision),
    principal: input.principal,
    sessionId: input.ownerSessionId,
  });
};

/** A marker remains ordinary text unless the exact canonical child operation claims it. */
export const claimHostedBuildMessage = async (input: {
  logicalSessionId: string;
  messageSequence: number;
  nonce: string;
  operationId: string;
  ownerSessionId: string;
  principal: HostedPrincipal;
  store: HostedEveStore;
  turnId: string;
  turnSequence: number;
}): Promise<boolean> =>
  (await input.store.claimInternalBuildMessage?.({
    logicalSessionId: input.logicalSessionId,
    messageSequence: input.messageSequence,
    nonce: input.nonce,
    operationId: input.operationId,
    principal: input.principal,
    sessionId: input.ownerSessionId,
    turnId: input.turnId,
    turnSequence: input.turnSequence,
  })) ?? false;
export const recordApprovedBuildDecision = async (
  ctx: Pick<HookContext, "session">,
  decision: ApprovedBuildDecision,
): Promise<void> => {
  const projection = currentGitHubPrDeliveryAuthorityProjection();
  const parsed = approvedBuildDecisionSchema.parse({ ...decision, githubDelivery: projection });
  if (hasTestCapability("simulated-target")) {
    diagnosticBuildDecisionState.update(() => parsed);
    markGitHubPrDeliveryAuthorityProjected(projection);
    return;
  }
  if ((await readLocalOperatorArtifactAuthority()) !== undefined) {
    const { recordLocalBuildDecision } = await import("./local-build-continuation");
    await recordLocalBuildDecision(ctx, parsed);
    markGitHubPrDeliveryAuthorityProjected(projection);
    return;
  }
  const { owner, principal, store } = await continuationOwnerStore(ctx);
  await persistHostedBuildDecision({
    decision: parsed,
    ownerSessionId: owner.sessionId,
    principal,
    store,
  });
  markGitHubPrDeliveryAuthorityProjected(projection);
};
/** A marker is internal only after its private canonical reservation accepts this exact delivered event. */
const verifyInternalBuildMessage = async (
  ctx: Pick<HookContext, "session">,
  input: { message: string; messageSequence: number; turnId: string },
): Promise<boolean> => {
  const marker = readInternalBuildMarker(input.message);
  if (marker?.operationId === undefined || marker.nonce === undefined) {
    return false;
  }
  if ((await readLocalOperatorArtifactAuthority()) !== undefined) {
    const { claimLocalBuildMessage } = await import("./local-build-continuation");
    return await claimLocalBuildMessage(ctx, {
      ...input,
      nonce: marker.nonce,
      operationId: marker.operationId,
    });
  }
  const { owner, principal, store } = await continuationOwnerStore(ctx);
  return await claimHostedBuildMessage({
    logicalSessionId: ctx.session.id,
    messageSequence: input.messageSequence,
    nonce: marker.nonce,
    operationId: marker.operationId,
    ownerSessionId: owner.sessionId,
    principal,
    store,
    turnId: input.turnId,
    turnSequence: ctx.session.turn.sequence,
  });
};

export const emitCurrentBuildWorkflowProjection = async (
  ctx: Pick<HookContext, "session">,
): Promise<void> => {
  const [{ assertApprovedPrivateApplySession }, { decideApprovedBuildContinuation }] =
    await Promise.all([
      import("./private-apply-authority"),
      import("./approved-build-continuation"),
    ]);
  const decision = decideApprovedBuildContinuation({
    adapterSessionId: ctx.session.id,
    repositoryAccess: repositoryAccessReceiptState.get(),
    approvalMatches: (scope) => {
      try {
        assertApprovedPrivateApplySession(scope);
        return true;
      } catch {
        return false;
      }
    },
    blocked: false,
    pendingInput: false,
    state: appBuilderWorkflowState.get(),
    sourcePrerequisite: currentLocalSourcePrerequisite(
      appBuilderWorkflowState.get(),
      ctx.session.id,
    ),
    turnId: ctx.session.turn.id,
    turnSequence: ctx.session.turn.sequence,
  });
  decision.decision = "working";
  if (decision.currentSpec !== undefined) {
    await recordApprovedBuildDecision(ctx, decision);
  }
};

/** Failure to authenticate an internal marker never discards an ordinary human message. */
export const authenticatedInternalBuildMessage = async (
  ctx: Pick<HookContext, "session">,
  input: { message: string; messageSequence: number; turnId: string },
): Promise<boolean> => {
  try {
    const claimed = await verifyInternalBuildMessage(ctx, input);
    if (claimed) {
      authenticatedBuildDelivery.update(() => ({
        progress: currentApprovedBuildProgress(),
        turnId: input.turnId,
      }));
    }
    return claimed;
  } catch {
    return false;
  }
};
