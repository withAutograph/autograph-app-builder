import type { HookContext } from "eve/hooks";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import {
  approvedBuildDecisionSchema,
  readInternalBuildMarker,
} from "./approved-build-continuation";
import type { ApprovedBuildDecision } from "./approved-build-continuation";

// oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Authenticate the current owner before opening its private persistence adapter.
const ownerStore = async (ctx: Pick<HookContext, "session">) => {
  const { authority, principal } = exactForwardedSessionAuthority(ctx.session.auth);
  const owner = await resolveHostedOperatorOwnerContext({
    adapterSessionId: ctx.session.id,
    authority,
    environment: process.env,
    principal,
    sessionAuth: ctx.session.auth,
  });
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Establish current owner authority before opening the private persistence adapter.
  const { openHostedPostgresDatabase } = await import("../mcp/hosted-route");
  const config = readPreviewOAuthRuntimeConfig({ ...process.env });
  const store = createPostgresHostedEveStore(openHostedPostgresDatabase(config.databaseUrl));
  return { owner, principal, store };
};
export const recordApprovedBuildDecision = async (
  ctx: Pick<HookContext, "session">,
  decision: ApprovedBuildDecision,
): Promise<void> => {
  const parsed = approvedBuildDecisionSchema.parse(decision);
  if ((await readLocalOperatorArtifactAuthority()) !== undefined) {
    const { recordLocalBuildDecision } = await import("./local-build-continuation");
    await recordLocalBuildDecision(ctx, parsed);
    return;
  }
  const { owner, principal, store } = await ownerStore(ctx);
  await store.recordPrivateBuildDecision?.({
    decision: parsed,
    principal,
    sessionId: owner.sessionId,
  });
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
  const { owner, principal, store } = await ownerStore(ctx);
  return (
    (await store.claimInternalBuildMessage?.({
      messageSequence: input.messageSequence,
      nonce: marker.nonce,
      operationId: marker.operationId,
      principal,
      sessionId: owner.sessionId,
      turnId: input.turnId,
      turnSequence: ctx.session.turn.sequence,
    })) ?? false
  );
};

export const emitCurrentBuildWorkflowProjection = async (
  ctx: Pick<HookContext, "session">,
): Promise<void> => {
  const [
    { appBuilderWorkflowState },
    { assertApprovedPrivateApplySession },
    { decideApprovedBuildContinuation },
  ] = await Promise.all([
    import("./workflow-state"),
    import("./private-apply-authority"),
    import("./approved-build-continuation"),
  ]);
  const decision = decideApprovedBuildContinuation({
    adapterSessionId: ctx.session.id,
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
    return await verifyInternalBuildMessage(ctx, input);
  } catch {
    return false;
  }
};
