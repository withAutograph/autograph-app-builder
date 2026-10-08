import { z } from "zod";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { PrivateApplyScope } from "./private-apply-authority";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const approvedBuildScopeSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  appSpecDigest: digest,
  proposalDigest: digest,
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
});
export const approvedBuildDecisionSchema = z.strictObject({
  adapterSessionId: z.string().min(1),
  currentSpec: z
    .strictObject({
      appId: z.string(),
      appSpecDigest: digest,
      proposalDigest: digest.optional(),
      sessionId: z.string(),
      workspaceId: z.string(),
    })
    .optional(),
  decision: z.enum(["working", "runnable", "waiting-input", "blocked", "settled"]),
  scope: approvedBuildScopeSchema.optional(),
  turnId: z.string().min(1),
  turnSequence: z.number().int().nonnegative(),
  validation: z
    .strictObject({
      attemptDigest: digest,
      command: z.enum(["check-build", "test"]),
      exitCode: z.number().int(),
      reason: z.literal("command-failed"),
    })
    .optional(),
  version: z.literal(1),
  workflowPhase: z.string().min(1),
});
export type ApprovedBuildDecision = z.infer<typeof approvedBuildDecisionSchema>;
export const internalBuildContinuationSchema = z.strictObject({
  decision: approvedBuildDecisionSchema,
  deliveredMessageSequence: z.number().int().nonnegative().optional(),
  deliveredTurnId: z.string().min(1).optional(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type InternalBuildContinuation = z.infer<typeof internalBuildContinuationSchema>;
const marker =
  /\n\[autograph-private-build:(?<operationId>[a-z0-9_:-]+):(?<nonce>[a-f0-9]{64})\]$/u;
export const readInternalBuildMarker = (message: string) => marker.exec(message)?.groups;
export const internalBuildMessage = (operationId: string, nonce: string) =>
  "Continue the existing approved private app build. Resolve its remaining app-owned repair and validation through supported workflow capabilities. Keep the current session and scope. Wait for actual provider, human-input, or outward-effect approval boundaries. This runtime continuation is not a new user requirement or approval." +
  `\n[autograph-private-build:${operationId}:${nonce}]`;

/** Source-owned state, actual retained approval and validator facts determine runnable work; model prose is never an input. */
export const decideApprovedBuildContinuation = (input: {
  state: AppBuilderWorkflowState;
  adapterSessionId: string;
  turnId: string;
  turnSequence: number;
  approvalMatches: (scope: PrivateApplyScope) => boolean;
  pendingInput: boolean;
  blocked: boolean;
}): ApprovedBuildDecision => {
  const base = {
    adapterSessionId: input.adapterSessionId,
    turnId: input.turnId,
    turnSequence: input.turnSequence,
    version: 1 as const,
    workflowPhase: input.state.phase,
  };
  if ("appSpec" in input.state) {
    const { state } = input;
    const currentSpec: NonNullable<ApprovedBuildDecision["currentSpec"]> = {
      appId: state.appSpec.appId,
      appSpecDigest: state.appSpec.digest,
      sessionId: input.adapterSessionId,
      workspaceId: state.workspace.workspaceId,
    };
    if ("proposal" in state) {
      currentSpec.proposalDigest = state.proposal.digest;
    }
    Object.assign(base, { currentSpec });
  }
  if (input.pendingInput) {
    return { ...base, decision: "waiting-input" };
  }
  if (input.blocked || !("applyReceipt" in input.state)) {
    return { ...base, decision: "blocked" };
  }
  const { state } = input;
  const scope = {
    appId: state.appSpec.appId,
    appSpecDigest: state.appSpec.digest,
    proposalDigest: state.proposal.digest,
    sessionId: input.adapterSessionId,
    workspaceId: state.workspace.workspaceId,
  };
  if (!input.approvalMatches(scope)) {
    return { ...base, decision: "blocked" };
  }
  if (state.phase === "applied" || state.phase === "validation_pending") {
    return { ...base, decision: "runnable", scope };
  }
  if (state.phase !== "validation_failed") {
    return { ...base, decision: "settled", scope };
  }
  const failure = state.validationFailure;
  const command = failure.commandFailure;
  // The validator runs the approved app's check/test command. Diagnostic paths
  // describe stack frames, not repair ownership: unchanged tests and shared
  // runtime frames must not stop the approved app's private repair loop.
  if (
    failure.reason !== "command-failed" ||
    command === undefined ||
    !["check-build", "test"].includes(command.name)
  ) {
    return { ...base, decision: "blocked", scope };
  }
  return approvedBuildDecisionSchema.parse({
    ...base,
    decision: "runnable",
    scope,
    validation: {
      attemptDigest: failure.attemptDigest,
      command: command.name,
      exitCode: command.exitCode,
      reason: failure.reason,
    },
  });
};
