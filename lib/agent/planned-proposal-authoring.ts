/* oxlint-disable sonarjs/expression-complexity -- Keep each exact owner, source, denial and no-execution comparison visible at this read-only observation boundary. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";
import { z } from "zod";
import { appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { readPrivateApplyAuthority } from "./private-apply-authority";
import { existingAppRepairHistory } from "./existing-app-repair-planning";
import { plannedAuthoringCorrectionSchema } from "./preapproval-authoring";
import type { PlannedAuthoringCorrection } from "./preapproval-authoring";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Context = Pick<HookContext, "session">;
interface Observation {
  ownerSessionId: string;
  scope: {
    appId: string;
    appSpecDigest: string;
    proposalDigest: string;
    workspaceId: string;
    sessionId: string;
  };
  sourceReceiptDigest: string;
  workspaceDigest: string;
  denialEvidenceDigest: string;
  requestTurnId: string;
  requestTurnSequence: number;
  requestMessageSequence: number;
  requestMessageDigest: string;
  inspectionCallId?: string;
}
const observation = defineState<Observation | null>(
  "autograph-app-builder.planned-proposal-authoring.v1",
  () => null,
);

/** Existing verified denial bookkeeping only. No missing-card or prose inference. */
// oxlint-disable-next-line eslint/complexity -- Keep every independent immutable scope and denied-not-run comparison visible before authoring may continue.
export const inspectPlannedAuthoringCandidate = (input: {
  current: AppBuilderWorkflowState;
  authority: ReturnType<typeof readPrivateApplyAuthority>;
  history: ReturnType<typeof existingAppRepairHistory.get>;
  sessionId: string;
}) => {
  const { current, authority, history, sessionId } = input;
  if (
    current.phase !== "planned" ||
    "applyReceipt" in current ||
    authority.pending.length !== 0 ||
    authority.grant?.proposalDigest === current.proposal.digest ||
    !("iteration" in current.proposal.target) ||
    current.proposal.target.operation !== "iterate-existing-app"
  ) {
    return null;
  }
  const { target } = current.proposal;
  if (
    target.contract.appId !== current.appSpec.appId ||
    target.contract.appSpec.sha256 !== current.appSpec.digest ||
    current.identityReceipt?.identity.appId !== current.appSpec.appId ||
    current.proposal.contractDigest !== sha256(JSON.stringify(target.contract)) ||
    target.iteration.digest !== sha256(JSON.stringify(target.iteration.changes))
  ) {
    return null;
  }
  const { digest, ...unsigned } = current.proposal;
  if (
    sha256(JSON.stringify(unsigned)) !== digest ||
    current.proposal.appSpecDigest !== current.appSpec.digest ||
    current.proposal.sourceReceiptDigest !== current.sourceReceipt.digest ||
    current.proposal.workspaceDigest !== current.workspace.workspaceDigest ||
    history.some((row) => row.proposalDigest === digest && row.sessionId !== sessionId)
  ) {
    return null;
  }
  const scope = {
    appId: current.appSpec.appId,
    appSpecDigest: current.appSpec.digest,
    proposalDigest: digest,
    sessionId,
    workspaceId: current.workspace.workspaceId,
  };
  const denial = authority.terminalDecisions?.findLast(
    (row) =>
      row.outcome === "denied-not-run" &&
      row.sessionId === sessionId &&
      row.eventIds.length >= 3 &&
      isDeepStrictEqual(row.scope, scope),
  );
  if (!denial) {
    return null;
  }
  return {
    denialEvidenceDigest: denial.evidenceDigest,
    ownerSessionId: sessionId,
    scope,
    sourceReceiptDigest: current.sourceReceipt.digest,
    workspaceDigest: current.workspace.workspaceDigest,
  };
};

const candidate = (ctx: Context) =>
  inspectPlannedAuthoringCandidate({
    authority: readPrivateApplyAuthority(),
    current: appBuilderWorkflowState.get(),
    history: existingAppRepairHistory.get(),
    sessionId: ctx.session.id,
  });

/** Called only after both internal marker verifiers reject the native user message. */
export const observePlannedAuthoringRequest = (
  ctx: Context,
  input: {
    message: string;
    turnId: string;
    sequence: number;
  },
) => {
  const selected = candidate(ctx);
  const next =
    selected &&
    input.turnId === ctx.session.turn.id &&
    Number.isSafeInteger(input.sequence) &&
    input.sequence >= 0
      ? {
          ...selected,
          requestMessageDigest: hash(input.message),
          requestMessageSequence: input.sequence,
          requestTurnId: input.turnId,
          requestTurnSequence: ctx.session.turn.sequence,
        }
      : null;
  const prior = observation.get();
  if (
    prior &&
    prior.requestTurnId === input.turnId &&
    prior.requestMessageSequence === input.sequence
  ) {
    const comparable = { ...prior, inspectionCallId: undefined };
    if (next && isDeepStrictEqual(comparable, { ...next, inspectionCallId: undefined })) {
      return;
    }
    // A replay with substituted bytes or a changed immutable target is not a new request.
    observation.update(() => null);
    return;
  }
  observation.update(() => next);
};

const selectedObservation = (value: Observation) => ({
  denialEvidenceDigest: value.denialEvidenceDigest,
  ownerSessionId: value.ownerSessionId,
  scope: value.scope,
  sourceReceiptDigest: value.sourceReceiptDigest,
  workspaceDigest: value.workspaceDigest,
});
const inspectionSchema = z.object({
  appId: z.string(),
  proposalDigest: z.string(),
  source: z.literal("current-proposal"),
  status: z.literal("UNAPPLIED"),
});
/** Only a completed real current-draft inspection arms the already-observed request. */
export const observePlannedAuthoringInspection = (
  event: HookEvent<"action.result">,
  ctx: Context,
) => {
  const retained = observation.get();
  if (
    !retained ||
    retained.inspectionCallId !== undefined ||
    retained.requestTurnId !== ctx.session.turn.id ||
    event.data.status !== "completed" ||
    event.data.error !== undefined ||
    event.data.result.kind !== "tool-result" ||
    event.data.result.isError === true ||
    event.data.result.toolName !== "inspect_existing_app"
  ) {
    return;
  }
  const selected = candidate(ctx);
  const output = inspectionSchema.safeParse(event.data.result.output);
  if (
    !selected ||
    !isDeepStrictEqual(selected, selectedObservation(retained)) ||
    !output.success ||
    output.data.appId !== retained.scope.appId ||
    output.data.proposalDigest !== retained.scope.proposalDigest
  ) {
    return;
  }
  observation.update(() => ({ ...retained, inspectionCallId: event.data.result.callId }));
};

/** Same immutable correction survives an internal turn; new reads cannot reset its fence. */
export const currentPlannedAuthoringCorrection = (
  ctx: Context,
): PlannedAuthoringCorrection | undefined => {
  const retained = observation.get();
  if (
    retained?.inspectionCallId === undefined ||
    retained.ownerSessionId !== ctx.session.id ||
    ctx.session.turn.sequence < retained.requestTurnSequence
  ) {
    return undefined;
  }
  const selected = candidate(ctx);
  const {
    requestTurnId,
    requestTurnSequence,
    requestMessageSequence,
    requestMessageDigest,
    inspectionCallId,
  } = retained;
  if (!selected || !isDeepStrictEqual(selected, selectedObservation(retained))) {
    return undefined;
  }
  return plannedAuthoringCorrectionSchema.parse({
    denialEvidenceDigest: retained.denialEvidenceDigest,
    inspectionCallId,
    proposalDigest: retained.scope.proposalDigest,
    requestMessageDigest,
    requestMessageSequence,
    requestTurnId,
    requestTurnSequence,
  });
};
