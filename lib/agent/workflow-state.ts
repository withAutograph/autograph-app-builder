import { createHash } from "node:crypto";

import { defineState } from "eve/context";

import type { PreparedSandboxWorkspace } from "@/lib/repository/supported-template";
import type {
  TargetIdentity,
  TargetProposal,
} from "@/lib/repository/target-planning";
import type {
  TargetApplyFailureReceipt,
  TargetApplyReceipt,
} from "@/lib/repository/target-apply";
import type {
  TargetValidationAttemptReceipt,
  TargetValidationFailureReceipt,
  TargetValidationReceipt,
} from "@/lib/repository/target-validation";
import type { ReviewedChangeSetReceipt } from "@/lib/repository/reviewed-change-set";
import type { SourceReceipt } from "@/lib/repository/source-receipt";
import type {
  LocalPublicationFailureReceipt,
  LocalPublicationProposal,
  LocalPublicationSuccessReceipt,
} from "@/lib/repository/local-publication";
import type {
  BranchWorktreePublicationFailureReceipt,
  BranchWorktreePublicationProposal,
  BranchWorktreePublicationSuccessReceipt,
} from "@/lib/repository/branch-worktree-publication";

export const APP_BUILDER_WORKFLOW_VERSION = 10 as const;

export type AcceptedAppSpec = {
  appId: string;
  artifactPath: string;
  content: string;
  digest: string;
  acceptedByCallId: string;
  artifactRevision: string;
};

export type PrototypeArtifact = {
  appId: string;
  path: string;
  mediaType: "text/markdown" | "text/html";
  content: string;
  digest: string;
  revision: string;
  sessionId: string;
  recordedByCallId: string;
};

type TargetExecutionBinding = {
  sourceSha: string;
  eligibilityDigest: string;
  workspaceDigest: string;
  imageDigest: string;
  dependencyCacheDigest: string;
  appSpecDigest: string;
  artifactRevision: string;
};

export type DependencyPreparationReceipt = TargetExecutionBinding & {
  version: 1;
  targetSha: string;
  targetTree: string;
  cacheManifestDigest: string;
  cacheContentDigest: string;
  preparedByCallId: string;
  digest: string;
};

export type TargetIdentityReceipt = TargetExecutionBinding & {
  version: 1;
  identity: TargetIdentity;
  resolvedByCallId: string;
  digest: string;
};

export type AppCreationProposal = TargetExecutionBinding & {
  version: 1;
  identityDigest: string;
  contractDigest: string;
  target: TargetProposal;
  plannedByCallId: string;
  digest: string;
};

type WorkspacePhase = {
  workspace: PreparedSandboxWorkspace;
  sourceReceipt: SourceReceipt;
  preparedByCallId: string;
  artifacts: readonly PrototypeArtifact[];
};

type ReviewedPhase = WorkspacePhase & {
  appSpec: AcceptedAppSpec;
  dependencyReceipt: DependencyPreparationReceipt;
  identityReceipt: TargetIdentityReceipt;
  proposal: AppCreationProposal;
  applyReceipt: TargetApplyReceipt;
  validationReceipt: TargetValidationReceipt;
  reviewReceipt: ReviewedChangeSetReceipt;
};

export type AppBuilderWorkflowState =
  | { version: typeof APP_BUILDER_WORKFLOW_VERSION; phase: "empty" }
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "prepared";
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "app_spec_accepted";
      appSpec: AcceptedAppSpec;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "dependencies_prepared";
      appSpec: AcceptedAppSpec;
      dependencyReceipt: DependencyPreparationReceipt;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "identity_resolved";
      appSpec: AcceptedAppSpec;
      dependencyReceipt: DependencyPreparationReceipt;
      identityReceipt: TargetIdentityReceipt;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "planned";
      appSpec: AcceptedAppSpec;
      dependencyReceipt: DependencyPreparationReceipt;
      identityReceipt: TargetIdentityReceipt;
      proposal: AppCreationProposal;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "apply_failed";
      appSpec: AcceptedAppSpec;
      dependencyReceipt: DependencyPreparationReceipt;
      identityReceipt: TargetIdentityReceipt;
      proposal: AppCreationProposal;
      applyFailure: TargetApplyFailureReceipt;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "applied";
      appSpec: AcceptedAppSpec;
      dependencyReceipt: DependencyPreparationReceipt;
      identityReceipt: TargetIdentityReceipt;
      proposal: AppCreationProposal;
      applyReceipt: TargetApplyReceipt;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "validation_pending";
      appSpec: AcceptedAppSpec;
      dependencyReceipt: DependencyPreparationReceipt;
      identityReceipt: TargetIdentityReceipt;
      proposal: AppCreationProposal;
      applyReceipt: TargetApplyReceipt;
      validationAttempt: TargetValidationAttemptReceipt;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "validation_failed";
      appSpec: AcceptedAppSpec;
      dependencyReceipt: DependencyPreparationReceipt;
      identityReceipt: TargetIdentityReceipt;
      proposal: AppCreationProposal;
      applyReceipt: TargetApplyReceipt;
      validationFailure: TargetValidationFailureReceipt;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "validated";
      appSpec: AcceptedAppSpec;
      dependencyReceipt: DependencyPreparationReceipt;
      identityReceipt: TargetIdentityReceipt;
      proposal: AppCreationProposal;
      applyReceipt: TargetApplyReceipt;
      validationReceipt: TargetValidationReceipt;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "reviewed";
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "publication_pending";
      publicationProposal: LocalPublicationProposal;
      publicationCallId: string;
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "publication_failed";
      publicationReceipt: LocalPublicationFailureReceipt;
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "published_local";
      publicationReceipt: LocalPublicationSuccessReceipt;
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "branch_publication_pending";
      branchPublicationProposal: BranchWorktreePublicationProposal;
      branchPublicationCallId: string;
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "branch_publication_failed";
      branchPublicationReceipt: BranchWorktreePublicationFailureReceipt;
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "published_branch_worktree";
      branchPublicationReceipt: BranchWorktreePublicationSuccessReceipt;
    } & ReviewedPhase);

export type PublicationWorkflowPhase = Extract<
  AppBuilderWorkflowState,
  {
    phase:
      | "publication_pending"
      | "publication_failed"
      | "published_local"
      | "branch_publication_pending"
      | "branch_publication_failed"
      | "published_branch_worktree";
  }
>;

export function isPublicationWorkflowPhase(
  state: AppBuilderWorkflowState,
): state is PublicationWorkflowPhase {
  return (
    state.phase === "publication_pending" ||
    state.phase === "publication_failed" ||
    state.phase === "published_local" ||
    state.phase === "branch_publication_pending" ||
    state.phase === "branch_publication_failed" ||
    state.phase === "published_branch_worktree"
  );
}

/**
 * The workflow aggregate is the sole mutation authority. Every operation that
 * can invalidate a reviewed publication must call this before any source,
 * sandbox, or target I/O.
 */
export function assertUpstreamMutationAllowed(
  state: AppBuilderWorkflowState,
  operation: string,
): void {
  if (isPublicationWorkflowPhase(state))
    throw new Error(
      `Local publication is ${state.phase}; ${operation} is permanently disabled for this workflow.`,
    );
}

export function assertExactWorkflowState(
  latest: AppBuilderWorkflowState,
  expected: AppBuilderWorkflowState,
  operation: string,
): void {
  if (sha256(JSON.stringify(latest)) !== sha256(JSON.stringify(expected)))
    throw new Error(`The workflow changed concurrently before ${operation}.`);
}

export function assertPublicationJournalStatus(
  phase:
    | "reviewed"
    | "publication_pending"
    | "publication_failed"
    | "published_local",
  status: "pending" | "failed" | "succeeded" | undefined,
): void {
  const allowed: Record<typeof phase, readonly (typeof status)[]> = {
    reviewed: [undefined],
    publication_pending: [undefined, "pending", "failed", "succeeded"],
    publication_failed: [undefined, "failed"],
    published_local: ["succeeded"],
  };
  if (!allowed[phase].includes(status))
    throw new Error(
      `Workflow phase ${phase} cannot be paired with local-publication journal ${status ?? "absent"}.`,
    );
}

export function workflowWorkspace(
  state: AppBuilderWorkflowState,
): PreparedSandboxWorkspace | undefined {
  return state.phase === "empty" ? undefined : state.workspace;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validAppId(appId: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(appId);
}

export const appBuilderWorkflowState = defineState<AppBuilderWorkflowState>(
  "autograph-app-builder.workflow.v9",
  () => ({ version: APP_BUILDER_WORKFLOW_VERSION, phase: "empty" }),
);
