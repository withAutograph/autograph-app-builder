/* oxlint-disable unicorn/no-useless-undefined -- Explicit absence distinguishes optional provenance from a blocked observation. */
import { defineState } from "eve/context";
import { z } from "zod";
import type { AppBuilderWorkflowState } from "./workflow-state";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const localSourcePrerequisiteObservationSchema = z.strictObject({
  appId: z.string().min(1),
  appSpecDigest: digest,
  code: z.literal("local_source_baseline_required"),
  observedByCallId: z.string().min(1),
  originalSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  originalWorkspaceDigest: digest,
  proposalDigest: digest.optional(),
  sessionId: z.string().min(1),
  sourceReceiptDigest: digest,
  status: z.enum(["blocked", "resolved"]),
  version: z.literal(1),
  workspaceId: z.string().min(1),
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
  const { appId, digest: appSpecDigest } = state.appSpec;
  const sourceReceiptDigest = state.sourceReceipt.digest;
  const originalSourceSha = state.sourceReceipt.sourceSha;
  const originalWorkspaceDigest =
    "proposal" in state ? state.proposal.workspaceDigest : state.workspace.workspaceDigest;
  const hasProposal = "proposal" in state;
  const proposalDigest = hasProposal ? state.proposal.digest : undefined;
  const { workspaceId } = state.workspace;
  const result: Pick<
    LocalSourcePrerequisiteObservation,
    | "appId"
    | "appSpecDigest"
    | "originalSourceSha"
    | "originalWorkspaceDigest"
    | "proposalDigest"
    | "sessionId"
    | "sourceReceiptDigest"
    | "workspaceId"
  > = {
    appId,
    appSpecDigest,
    originalSourceSha,
    originalWorkspaceDigest,
    sessionId,
    sourceReceiptDigest,
    workspaceId,
  };
  if (hasProposal) result.proposalDigest = proposalDigest;
  return result;
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
    observations: localSourcePrerequisiteHistory.get(),
    sessionId,
    state,
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
    code: "local_source_baseline_required",
    observedByCallId: input.callId,
    status: "blocked",
    version: 1,
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
    { ...observed, observedByCallId: callId, status: "resolved" },
  ]);
  return undefined;
};
