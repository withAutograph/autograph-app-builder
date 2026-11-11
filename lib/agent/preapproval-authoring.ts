import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppBuilderWorkflowState } from "./workflow-state";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const plannedAuthoringCorrectionSchema = z.strictObject({
  proposalDigest: digest,
  denialEvidenceDigest: digest,
  requestTurnId: z.string().min(1),
  requestTurnSequence: z.number().int().nonnegative(),
  requestMessageSequence: z.number().int().nonnegative(),
  requestMessageDigest: digest,
  inspectionCallId: z.string().min(1),
});
export type PlannedAuthoringCorrection = z.infer<typeof plannedAuthoringCorrectionSchema>;
/** Accepted product intent only. This is never an apply or provider grant. */
export const preapprovalAuthoringScopeSchema = z.strictObject({
  authoritySessionId: z.string().min(1),
  appId: z.string().min(1),
  appSpecDigest: digest,
  acceptedByCallId: z.string().min(1),
  artifactPath: z.string().min(1),
  artifactRevision: z.string().min(1),
  sourceReceiptDigest: digest,
  workspaceId: z.string().min(1),
  workspaceDigest: digest,
  planningStateDigest: digest,
  correction: plannedAuthoringCorrectionSchema.optional(),
});
export type PreapprovalAuthoringScope = z.infer<typeof preapprovalAuthoringScopeSchema>;
export const authoringScopeDigest = (scope: PreapprovalAuthoringScope) =>
  createHash("sha256").update(JSON.stringify(scope)).digest("hex");
export const preapprovalAuthoringDecisionSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("preapproval-authoring-decision-v1"),
    adapterSessionId: z.string().min(1),
    turnId: z.string().min(1),
    turnSequence: z.number().int().nonnegative(),
    decision: z.enum(["working", "runnable", "blocked", "waiting-input", "planned"]),
    scope: preapprovalAuthoringScopeSchema.optional(),
    scopeDigest: digest.optional(),
    reason: z.enum(["authoring_no_progress", "authoring_cancelled"]).optional(),
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
  nonce: digest,
  deliveredTurnId: z.string().min(1).optional(),
  deliveredMessageSequence: z.number().int().nonnegative().optional(),
});
const marker =
  /\n\[autograph-preapproval-authoring:(?<operationId>[a-z0-9_:-]+):(?<nonce>[a-f0-9]{64})\]$/u;
export const readInternalAuthoringMarker = (message: string) => marker.exec(message)?.groups;
export const internalAuthoringMessage = (operationId: string, nonce: string) =>
  "Continue drafting the accepted app's complete implementation and tests through supported planning tools. Inspect the actual current draft when needed. Do not stop at an inspection summary or list of app-owned work. When correcting a declined current draft, freeze a successor proposal; do not retry the unchanged declined Build. Present the structured Build approval through the build tool before any implementation write. For an explicit direct Production request on an eligible private Arrusted app, include the current Production subject on that Build card. This is drafting continuation only: it grants no Build, publication, provider or release approval and changes no product requirements." +
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
    version: 1 as const,
    kind: "preapproval-authoring-decision-v1" as const,
    adapterSessionId: input.adapterSessionId,
    turnId: input.turnId,
    turnSequence: input.turnSequence,
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
  const authoringAuthority = (): Pick<
    PreapprovalAuthoringScope,
    "authoritySessionId" | "correction"
  > => {
    const authority: Pick<PreapprovalAuthoringScope, "authoritySessionId" | "correction"> = {
      authoritySessionId: input.adapterSessionId,
    };
    if (correcting) {
      authority.correction = input.correction;
    }
    return authority;
  };
  const candidate = preapprovalAuthoringScopeSchema.safeParse({
    ...authoringAuthority(),
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
          phase: current.phase,
          dependencyReceipt: "dependencyReceipt" in current ? current.dependencyReceipt : undefined,
          identityReceipt: "identityReceipt" in current ? current.identityReceipt : undefined,
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
