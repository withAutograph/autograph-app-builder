/* oxlint-disable unicorn/no-useless-undefined -- Explicit absence distinguishes optional provenance from a blocked observation. */
import { defineState } from "eve/context";
import { z } from "zod";
import type { AppBuilderWorkflowState } from "./workflow-state";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const localSourcePrerequisiteObservationSchema = z.strictObject({
  version: z.literal(1),
  code: z.literal("local_source_baseline_required"),
  status: z.enum(["blocked", "resolved"]),
  appId: z.string().min(1),
  appSpecDigest: digest,
  sourceReceiptDigest: digest,
  originalSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  originalWorkspaceDigest: digest,
  proposalDigest: digest.optional(),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  observedByCallId: z.string().min(1),
});
export type LocalSourcePrerequisiteObservation = z.infer<
  typeof localSourcePrerequisiteObservationSchema
>;
export const localSourcePrerequisiteHistory = defineState<
  readonly LocalSourcePrerequisiteObservation[]
>("autograph-app-builder.local-source-prerequisite.v1", () => []);

const binding = (state: AppBuilderWorkflowState, sessionId: string) => {
  if (!("appSpec" in state)) {
    return undefined;
  }
  return {
    appId: state.appSpec.appId,
    appSpecDigest: state.appSpec.digest,
    sourceReceiptDigest: state.sourceReceipt.digest,
    originalSourceSha: state.sourceReceipt.sourceSha,
    originalWorkspaceDigest:
      "proposal" in state ? state.proposal.workspaceDigest : state.workspace.workspaceDigest,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
    ...("proposal" in state ? { proposalDigest: state.proposal.digest } : {}),
    workspaceId: state.workspace.workspaceId,
    sessionId,
  };
};
export const matchingLocalSourcePrerequisite = (input: {
  state: AppBuilderWorkflowState;
  sessionId: string;
  observations: readonly LocalSourcePrerequisiteObservation[];
}) => {
  if (input.observations.length === 0) {
    return undefined;
  }
  const expected = binding(input.state, input.sessionId);
  if (expected === undefined) {
    return undefined;
  }
  const latest = input.observations.findLast((item) =>
    [
      item.appId === expected.appId,
      item.appSpecDigest === expected.appSpecDigest,
      item.sourceReceiptDigest === expected.sourceReceiptDigest,
      item.originalSourceSha === expected.originalSourceSha,
      item.originalWorkspaceDigest === expected.originalWorkspaceDigest,
      item.workspaceId === expected.workspaceId,
      item.sessionId === expected.sessionId,
      item.proposalDigest === expected.proposalDigest,
    ].every(Boolean),
  );
  return latest?.status === "blocked" ? latest : undefined;
};
export const currentLocalSourcePrerequisite = (state: AppBuilderWorkflowState, sessionId: string) =>
  matchingLocalSourcePrerequisite({
    state,
    sessionId,
    observations: localSourcePrerequisiteHistory.get(),
  });

/** Called only for the actual typed source error, never a message or diagnostic-text match. */
export const recordLocalSourcePrerequisite = (input: {
  state: AppBuilderWorkflowState;
  sessionId: string;
  callId: string;
  originalSourceSha: string;
  originalWorkspaceDigest: string;
}) => {
  const selected = binding(input.state, input.sessionId);
  if (
    selected === undefined ||
    selected.originalSourceSha !== input.originalSourceSha ||
    selected.originalWorkspaceDigest !== input.originalWorkspaceDigest
  ) {
    return undefined;
  }
  const observation = localSourcePrerequisiteObservationSchema.parse({
    ...selected,
    version: 1,
    code: "local_source_baseline_required",
    status: "blocked",
    observedByCallId: input.callId,
  });
  localSourcePrerequisiteHistory.update((history) => [...history, observation]);
  return observation;
};
/** A verified normal reconciliation resolves only its exact prior scope; old observations remain retained. */
export const resolveLocalSourcePrerequisite = (
  state: AppBuilderWorkflowState,
  sessionId: string,
  callId: string,
) => {
  const observed = currentLocalSourcePrerequisite(state, sessionId);
  if (observed === undefined) {
    return undefined;
  }
  localSourcePrerequisiteHistory.update((history) => [
    ...history,
    { ...observed, status: "resolved", observedByCallId: callId },
  ]);
  return undefined;
};
