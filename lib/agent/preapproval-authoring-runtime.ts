import { currentPlannedAuthoringCorrection } from "./planned-proposal-authoring";
import type { HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { continuationOwnerStore } from "./approved-build-continuation-runtime";
import { hasTestCapability } from "../testing/test-capability";
import {
  recordLocalAuthoringDecision,
  claimLocalAuthoringMessage,
  blockLocalAuthoringContinuation,
  readLocalAuthoringMarkerScope,
  localAuthoringConfigured,
} from "./local-preapproval-authoring";
import { appBuilderWorkflowState } from "./workflow-state";
import { currentLocalSourcePrerequisite } from "./local-source-prerequisite-state";
import { readPrivateApplyAuthority } from "./private-apply-authority";
import {
  decidePreapprovalAuthoring,
  readInternalAuthoringMarker,
  preapprovalAuthoringDecisionSchema,
} from "./preapproval-authoring";
import type { PreapprovalAuthoringDecision } from "./preapproval-authoring";

export const authenticatedAuthoringDelivery = defineState<{
  turnId: string;
  scopeDigest: string;
} | null>("autograph-app-builder.authenticated-authoring-delivery.v1", () => null);
export const diagnosticAuthoringDecisionState = defineState<PreapprovalAuthoringDecision | null>(
  "autograph-app-builder.diagnostic-authoring-decision.v1",
  () => null,
);
export const currentAuthoringDecision = (
  ctx: Pick<HookContext, "session">,
  boundary: { completed: boolean; blocked: boolean; pendingInput: boolean },
) =>
  decidePreapprovalAuthoring({
    ...boundary,
    adapterSessionId: ctx.session.id,
    correction: currentPlannedAuthoringCorrection(ctx),
    pendingApproval: readPrivateApplyAuthority().pending.length > 0,
    sourcePrerequisite:
      currentLocalSourcePrerequisite(appBuilderWorkflowState.get(), ctx.session.id) !== undefined,
    state: appBuilderWorkflowState.get(),
    turnId: ctx.session.turn.id,
    turnSequence: ctx.session.turn.sequence,
  });
/** An internal correction must produce a successor, never re-request its denied Build. */
export const internalCorrectionRequiresSuccessor = (ctx: Pick<HookContext, "session">): boolean => {
  const delivered = authenticatedAuthoringDelivery.get();
  if (!delivered || delivered.turnId !== ctx.session.turn.id) {
    return false;
  }
  const current = currentAuthoringDecision(ctx, {
    blocked: false,
    completed: false,
    pendingInput: false,
  });
  return current.scope?.correction !== undefined && current.scopeDigest === delivered.scopeDigest;
};
export const recordPreapprovalAuthoringDecision = async (
  ctx: Pick<HookContext, "session">,
  decision: PreapprovalAuthoringDecision,
): Promise<void> => {
  const parsed = preapprovalAuthoringDecisionSchema.parse(decision);
  if (hasTestCapability("simulated-target")) {
    diagnosticAuthoringDecisionState.update(() => parsed);
    return;
  }
  if (localAuthoringConfigured()) {
    await recordLocalAuthoringDecision(ctx, parsed);
    if (parsed.reason === "authoring_cancelled") {
      await blockLocalAuthoringContinuation(ctx.session.id, parsed.turnId);
    }
    return;
  }
  const { owner, principal, store } = await continuationOwnerStore(ctx);
  if (store.recordPreapprovalAuthoringDecision === undefined) {
    throw new Error("Authoring decision persistence unavailable.");
  }
  await store.recordPreapprovalAuthoringDecision({
    decision: parsed,
    principal,
    sessionId: owner.sessionId,
  });
};
/** Unauthenticated marker text is retained as an ordinary user message. */
export const authenticatedInternalAuthoringMessage = async (
  ctx: Pick<HookContext, "session">,
  input: { message: string; messageSequence: number; turnId: string },
): Promise<boolean> => {
  try {
    const marker = readInternalAuthoringMarker(input.message);
    if (marker?.operationId === undefined || marker.nonce === undefined) {
      return false;
    }
    if (localAuthoringConfigured()) {
      const scopeDigest = await readLocalAuthoringMarkerScope(ctx, {
        nonce: marker.nonce,
        operationId: marker.operationId,
      });
      if (scopeDigest === undefined) {
        return false;
      }
      const claimed = await claimLocalAuthoringMessage(ctx, {
        ...input,
        nonce: marker.nonce,
        operationId: marker.operationId,
        scopeDigest,
      });
      if (claimed) {
        authenticatedAuthoringDelivery.update(() => ({
          scopeDigest,
          turnId: input.turnId,
        }));
      }
      return claimed;
    }
    const { owner, principal, store } = await continuationOwnerStore(ctx);
    const operation = await store.getPrivateOperation?.(principal, marker.operationId);
    const reserved = operation?.internalAuthoringContinuation;
    if (
      reserved?.nonce !== marker.nonce ||
      operation?.sessionId !== owner.sessionId ||
      reserved.decision.adapterSessionId !== owner.adapterSessionId ||
      reserved.decision.scopeDigest === undefined
    ) {
      return false;
    }
    const { scopeDigest } = reserved.decision;
    const claimed =
      (await store.claimInternalAuthoringMessage?.({
        logicalSessionId: ctx.session.id,
        messageSequence: input.messageSequence,
        nonce: marker.nonce,
        operationId: marker.operationId,
        principal,
        scopeDigest,
        sessionId: owner.sessionId,
        turnId: input.turnId,
        turnSequence: ctx.session.turn.sequence,
      })) ?? false;
    if (claimed) {
      authenticatedAuthoringDelivery.update(() => ({
        scopeDigest,
        turnId: input.turnId,
      }));
    }
    return claimed;
  } catch {
    return false;
  }
};
