import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppBuilderWorkflowState } from "./workflow-state";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const plannedAuthoringCorrectionSchema = z.strictObject({
  denialEvidenceDigest: digest,
  inspectionCallId: z.string().min(1),
  proposalDigest: digest,
  requestMessageDigest: digest,
  requestMessageSequence: z.number().int().nonnegative(),
  requestTurnId: z.string().min(1),
  requestTurnSequence: z.number().int().nonnegative(),
});
export type PlannedAuthoringCorrection = z.infer<typeof plannedAuthoringCorrectionSchema>;
/** Accepted product intent only. This is never an apply or provider grant. */
export const preapprovalAuthoringScopeSchema = z.strictObject({
  acceptedByCallId: z.string().min(1),
  appId: z.string().min(1),
  appSpecDigest: digest,
  artifactPath: z.string().min(1),
  artifactRevision: z.string().min(1),
  authoritySessionId: z.string().min(1),
  correction: plannedAuthoringCorrectionSchema.optional(),
  planningStateDigest: digest,
  sourceReceiptDigest: digest,
  workspaceDigest: digest,
  workspaceId: z.string().min(1),
});
export type PreapprovalAuthoringScope = z.infer<typeof preapprovalAuthoringScopeSchema>;
export const authoringScopeDigest = (scope: PreapprovalAuthoringScope) =>
  createHash("sha256").update(JSON.stringify(scope)).digest("hex");
export const preapprovalAuthoringDecisionSchema = z
  .strictObject({
    adapterSessionId: z.string().min(1),
    decision: z.enum(["working", "runnable", "blocked", "waiting-input", "planned"]),
    kind: z.literal("preapproval-authoring-decision-v1"),
    reason: z.enum(["authoring_no_progress", "authoring_cancelled"]).optional(),
    scope: preapprovalAuthoringScopeSchema.optional(),
    scopeDigest: digest.optional(),
    turnId: z.string().min(1),
    turnSequence: z.number().int().nonnegative(),
    version: z.literal(1),
  })
  .superRefine((value, context) => {
    const unpaired = (value.scope === undefined) !== (value.scopeDigest === undefined);
    const unbound = value.decision === "runnable" && value.scope === undefined;
    const mismatched =
      value.scope !== undefined && authoringScopeDigest(value.scope) !== value.scopeDigest;
    if (unpaired || unbound || mismatched) {
      context.addIssue({ code: "custom", message: "Authoring intent binding is incomplete." });
    }
  });
export type PreapprovalAuthoringDecision = z.infer<typeof preapprovalAuthoringDecisionSchema>;
export const internalAuthoringContinuationSchema = z.strictObject({
  decision: preapprovalAuthoringDecisionSchema,
  deliveredMessageSequence: z.number().int().nonnegative().optional(),
  deliveredTurnId: z.string().min(1).optional(),
  nonce: digest,
});
const marker =
  /\n\[autograph-preapproval-authoring:(?<operationId>[a-z0-9_:-]+):(?<nonce>[a-f0-9]{64})\]$/u;
export const readInternalAuthoringMarker = (message: string) => marker.exec(message)?.groups;
export const internalAuthoringMessage = (operationId: string, nonce: string) =>
  "Continue drafting the accepted app's complete implementation and tests through supported planning tools. Inspect the actual current draft when needed. Do not stop at an inspection summary or list of app-owned work. When correcting a declined current draft, freeze a successor proposal; do not retry the unchanged declined Build. Obtain the normal fresh Build approval before any implementation write. This is drafting continuation only: it grants no Build, publication, provider or release approval and changes no product requirements." +
  `\n[autograph-preapproval-authoring:${operationId}:${nonce}]`;

const authoringPhases = new Set([
  "app_spec_accepted",
  "dependencies_prepared",
  "identity_resolved",
]);
/** The accepted native workflow is intent; assistant prose and a status query are not grants. */
export const decidePreapprovalAuthoring = (input: {
  state: AppBuilderWorkflowState;
  adapterSessionId: string;
  turnId: string;
  turnSequence: number;
  completed: boolean;
  pendingInput: boolean;
  pendingApproval: boolean;
  blocked: boolean;
  sourcePrerequisite: boolean;
  correction?: PlannedAuthoringCorrection;
}): PreapprovalAuthoringDecision => {
  const base = {
    adapterSessionId: input.adapterSessionId,
    kind: "preapproval-authoring-decision-v1" as const,
    turnId: input.turnId,
    turnSequence: input.turnSequence,
    version: 1 as const,
  };
  if (input.pendingInput || input.pendingApproval) {
    return { ...base, decision: "waiting-input" };
  }
  if (input.blocked || input.sourcePrerequisite) {
    return { ...base, decision: "blocked" };
  }
  const current = input.state;
  if (!("appSpec" in current)) {
    return { ...base, decision: "blocked" };
  }
  const correcting =
    current.phase === "planned" && input.correction?.proposalDigest === current.proposal.digest;
  if ("proposal" in current && !correcting) {
    return { ...base, decision: "planned" };
  }
  if (!authoringPhases.has(current.phase) && !correcting) {
    return { ...base, decision: "blocked" };
  }
  // Legacy inline AppSpecs and current durable artifact references are already
  // accepted by the versioned workflow. Do not invent an extra content gate.
  if (
    current.artifacts.some(
      (artifact) =>
        artifact.path === current.appSpec.artifactPath &&
        artifact.revision === current.appSpec.artifactRevision &&
        artifact.sessionId !== input.adapterSessionId,
    )
  ) {
    return { ...base, decision: "blocked" };
  }
  const authority = { authoritySessionId: input.adapterSessionId };
  const candidateAuthority = correcting
    ? { ...authority, correction: input.correction }
    : authority;
  const candidate = preapprovalAuthoringScopeSchema.safeParse({
    ...candidateAuthority,
    appId: current.appSpec.appId,
    appSpecDigest: current.appSpec.digest,
    acceptedByCallId: current.appSpec.acceptedByCallId,
    artifactPath: current.appSpec.artifactPath,
    artifactRevision: current.appSpec.artifactRevision,
    sourceReceiptDigest: current.sourceReceipt.digest,
    workspaceId: current.workspace.workspaceId,
    workspaceDigest: current.workspace.workspaceDigest,
    planningStateDigest: createHash("sha256")
      .update(
        JSON.stringify({
          dependencyReceipt: "dependencyReceipt" in current ? current.dependencyReceipt : undefined,
          identityReceipt: "identityReceipt" in current ? current.identityReceipt : undefined,
          phase: current.phase,
        }),
      )
      .digest("hex"),
  });
  if (!candidate.success) {
    return { ...base, decision: "blocked" };
  }
  return {
    ...base,
    decision: input.completed ? "runnable" : "working",
    scope: candidate.data,
    scopeDigest: authoringScopeDigest(candidate.data),
  };
};
