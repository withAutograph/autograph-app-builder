import {
  localSourcePrerequisiteObservationSchema,
  matchingLocalSourcePrerequisite,
} from "./local-source-prerequisite-state";
import type { LocalSourcePrerequisiteObservation } from "./local-source-prerequisite-state";
import { z } from "zod";
import { repositoryAccessReceiptSchema } from "./repository-access-state";
import type { RepositoryAccessReceipt } from "./repository-access-state";

import type { AppBuilderWorkflowState } from "./workflow-state";
import type { PrivateApplyScope } from "./private-apply-authority";
import type { EveSessionResult } from "../mcp/contracts";
import type { TargetApplyFailureReceipt } from "../repository/target-apply";
import type { TargetValidationFailureReceipt } from "../repository/target-validation";
import { appAccessIntentFields, appAccessIntentSchema } from "./app-access-intent";

const COMMAND_FAILED = "command-failed";
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
      access: appAccessIntentSchema.optional(),
      proposalDigest: digest.optional(),
      sessionId: z.string(),
      // Repository execution workspace, distinct from the authenticated tenant workspace.
      workspaceId: z.string(),
    })
    .optional(),
  existingRepositorySource: repositoryAccessReceiptSchema.optional(),

  decision: z.enum(["working", "runnable", "waiting-input", "blocked", "settled"]),
  reason: z.literal("build_no_progress").optional(),
  scope: approvedBuildScopeSchema.optional(),
  sourcePrerequisite: localSourcePrerequisiteObservationSchema.optional(),
  turnId: z.string().min(1),
  turnSequence: z.number().int().nonnegative(),
  validation: z
    .strictObject({
      attemptDigest: digest,
      command: z.enum(["check-build", "test"]),
      exitCode: z.number().int(),
      reason: z.enum([COMMAND_FAILED, "tooling-prerequisite"]),
      failureClass: z.enum(["native-tool-panic", "missing-app-task"]).optional(),
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

/** Compare the work that remains, ignoring fresh turn and attempt identifiers. */
export const approvedBuildProgress = (state: AppBuilderWorkflowState): string => {
  const proposal = "proposal" in state ? state.proposal.digest : null;
  const appliedTree = "applyReceipt" in state ? state.applyReceipt.postTreeDigest : null;
  if (state.phase === "apply_failed") {
    const failure = state.applyFailure;
    return JSON.stringify([
      state.phase,
      proposal,
      failure.postTreeDigest,
      failure.reason,
      failure.command.name,
      failure.command.exitCode,
      failure.commandFailureKind,
    ]);
  }
  if (state.phase === "validation_failed") {
    const { commandFailure, reason } = state.validationFailure;
    return JSON.stringify([
      state.phase,
      proposal,
      appliedTree,
      reason,
      commandFailure?.name,
      commandFailure?.exitCode,
      commandFailure?.failureClass,
    ]);
  }
  return JSON.stringify([state.phase, proposal, appliedTree]);
};

export const reportApprovedBuildNoProgress = (result: EveSessionResult): EveSessionResult => ({
  ...result,
  error: result.error ?? {
    code: "approved_build_no_progress",
    message:
      "Builder reached the same unfinished build step again. Your work is saved. Continue this session to inspect the last operation and repair the remaining issue.",
  },
});

const marker =
  /\n\[autograph-private-build:(?<operationId>[a-z0-9_:-]+):(?<nonce>[a-f0-9]{64})\]$/u;
export const readInternalBuildMarker = (message: string) => marker.exec(message)?.groups;
export const internalBuildMessage = (operationId: string, nonce: string) =>
  "Continue the existing approved private app build from its latest tool result. Continue implementing the approved product requirements that remain unfinished. Use a working preview to inspect and verify the implementation, and finish review when requested for delivery. A preview of partial work completes the request only when the user asked to inspect the current work or explicitly deferred the missing behavior. If the current app lacks an approved capability, continue its implementation within the existing scope and verify the result. Stop when the requested result is ready or when an actual provider, human-input, or outward-effect approval boundary requires it. Keep the current session and scope. This runtime continuation grants no new approval." +
  `\n[autograph-private-build:${operationId}:${nonce}]`;

const projectExistingRepositorySource = (
  workflow: AppBuilderWorkflowState,
  access: RepositoryAccessReceipt | undefined,
  adapterSessionId: string,
) => {
  if (
    workflow.phase === "empty" ||
    workflow.sourceReceipt?.sourceKind !== "existing-repository" ||
    workflow.githubSource === undefined ||
    access === undefined
  ) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing acquired source is an explicit optional private projection.
    return undefined;
  }
  if (
    ![
      access.sessionId === adapterSessionId,
      access.repository.repositoryId === workflow.githubSource.repository.repositoryId,
      access.repository.owner === workflow.githubSource.repository.owner,
      access.repository.name === workflow.githubSource.repository.name,
      workflow.githubSource.installationIdentityDigest ===
        workflow.githubSource.repository.installationIdentityDigest,
    ].every(Boolean)
  ) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing acquired source is an explicit optional private projection.
    return undefined;
  }
  return repositoryAccessReceiptSchema.parse(access);
};

const canRepairApplyFailure = (failure: TargetApplyFailureReceipt): boolean =>
  failure.reason === COMMAND_FAILED &&
  failure.command.exitCode > 0 &&
  !["app-lock", "partial-state", "stale-proposal", "timeout"].includes(
    failure.commandFailureKind ?? "",
  );

type ValidationCommandFailure = NonNullable<TargetValidationFailureReceipt["commandFailure"]>;
const isAppValidationFailure = (
  command: ValidationCommandFailure | undefined,
): command is ValidationCommandFailure =>
  command !== undefined && ["check-build", "test"].includes(command.name);

/** Source-owned state, actual retained approval and validator facts determine runnable work; model prose is never an input. */
export const decideApprovedBuildContinuation = (input: {
  state: AppBuilderWorkflowState;
  adapterSessionId: string;
  turnId: string;
  turnSequence: number;
  approvalMatches: (scope: PrivateApplyScope) => boolean;
  repositoryAccess?: RepositoryAccessReceipt;

  pendingInput: boolean;
  blocked: boolean;
  sourcePrerequisite?: LocalSourcePrerequisiteObservation;
}): ApprovedBuildDecision => {
  const base = {
    adapterSessionId: input.adapterSessionId,
    turnId: input.turnId,
    turnSequence: input.turnSequence,
    version: 1 as const,
    workflowPhase: input.state.phase,
  };
  const existingRepositorySource = projectExistingRepositorySource(
    input.state,
    input.repositoryAccess,
    input.adapterSessionId,
  );
  if (existingRepositorySource !== undefined) {
    Object.assign(base, { existingRepositorySource });
  }
  if ("appSpec" in input.state) {
    const { state } = input;
    const currentSpec: NonNullable<ApprovedBuildDecision["currentSpec"]> = {
      appId: state.appSpec.appId,
      appSpecDigest: state.appSpec.digest,
      ...appAccessIntentFields(state.appSpec.access),
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
  const sourcePrerequisite = matchingLocalSourcePrerequisite({
    state: input.state,
    sessionId: input.adapterSessionId,
    observations: input.sourcePrerequisite === undefined ? [] : [input.sourcePrerequisite],
  });
  if (sourcePrerequisite !== undefined) {
    return { ...base, decision: "blocked", sourcePrerequisite };
  }
  if (input.blocked || !("proposal" in input.state)) {
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
  if (state.phase === "apply_failed") {
    return {
      ...base,
      decision: canRepairApplyFailure(state.applyFailure) ? "runnable" : "blocked",
      scope,
    };
  }
  if (["planned", "applied", "validation_pending", "validated"].includes(state.phase)) {
    return { ...base, decision: "runnable", scope };
  }
  if (state.phase !== "validation_failed") {
    return { ...base, decision: "settled", scope };
  }
  const failure = state.validationFailure;
  const command = failure.commandFailure;
  if (failure.reason === "tooling-prerequisite" && command?.failureClass !== undefined) {
    return approvedBuildDecisionSchema.parse({
      ...base,
      decision: command.failureClass === "native-tool-panic" ? "runnable" : "blocked",
      scope,
      validation: {
        attemptDigest: failure.attemptDigest,
        command: command.name,
        exitCode: command.exitCode,
        reason: failure.reason,
        failureClass: command.failureClass,
      },
    });
  }
  // The validator runs the approved app's check/test command. Diagnostic paths
  // describe stack frames, not repair ownership: unchanged tests and shared
  // runtime frames must not stop the approved app's private repair loop.
  if (failure.reason !== COMMAND_FAILED || !isAppValidationFailure(command)) {
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
