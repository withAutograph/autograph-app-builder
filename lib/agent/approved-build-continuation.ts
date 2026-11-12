import { directProductionGrantSchema } from "./direct-production-authorization";
import type { DirectProductionGrant } from "./direct-production-authorization";
import { githubPrDeliveryAuthorityProjectionSchema } from "./github-pr-delivery-authority-contract";
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
  githubDelivery: githubPrDeliveryAuthorityProjectionSchema.optional(),
  directProduction: directProductionGrantSchema.optional(),
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
  dispatchBinding: z
    .strictObject({
      adapterGeneration: z.number().int().positive(),
      cancellationRevision: z.number().int().nonnegative(),
    })
    .optional(),
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
const privateBuildContinuation =
  "Finish implementing the approved app. Show a working private preview at its registered app route as the first working app handoff. Hand it off as soon as it works, even if optional browser checks are unavailable. If preview startup fails, report the concrete error and retry only after repairing the cause. Wait for the user's request before releasing to Production.";
const productionBuildContinuation =
  "Finish implementing the approved app. After required build and test commands pass, follow the saved Arrusted destination review and seal the exact changes. Continue through publication, Ready and merge, and native app availability using the authorized release operations. For a first release, complete Production setup. For an approved revision that retains its existing data and access, use the reviewed delivery tools to verify that setup before merge. Do not launch or await an optional private preview or browser test on this release path. Share the verified live app URL after native activation.";

export const internalBuildMessage = (
  operationId: string,
  nonce: string,
  directProduction = false,
) => {
  const purpose = directProduction ? productionBuildContinuation : privateBuildContinuation;
  return `Continue the existing approved app from its latest tool result. Keep the saved session and accepted scope. ${purpose} Stop when the requested result is ready or when an actual failure or new authority requires user input. This runtime continuation grants no new approval.\n[autograph-private-build:${operationId}:${nonce}]`;
};

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

  directProduction?: DirectProductionGrant;
  releaseFinished?: boolean;
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
  if (input.directProduction !== undefined) {
    Object.assign(base, { directProduction: input.directProduction });
  }
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
  if (input.directProduction !== undefined && input.releaseFinished === true) {
    return { ...base, decision: "settled", scope };
  }
  const continuingRelease = state.phase === "reviewed" && input.directProduction !== undefined;
  if (
    continuingRelease ||
    ["planned", "applied", "validation_pending", "validated"].includes(state.phase)
  ) {
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
