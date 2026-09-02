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
import type {
  FreshBootstrapFailureReceipt,
  FreshBootstrapProposal,
  FreshBootstrapSuccessReceipt,
} from "@/lib/repository/fresh-bootstrap";
import type {
  DraftPullRequestProposal,
  ImmutableGitHubSourceReceipt,
} from "@/lib/repository/github-publication";
import type { ApprovalReceipt } from "@/lib/agent/approval-receipt";
import type { ExecutionDependencyLayout } from "@/lib/repository/dependency-cache";

export const APP_BUILDER_WORKFLOW_VERSION = 17 as const;
export const APP_BUILDER_WORKFLOW_STATE_KEY =
  "autograph-app-builder.workflow.v17" as const;

export type AcceptedAppSpec = {
  appId: string;
  artifactPath: string;
  content: string;
  digest: string;
  acceptedByCallId: string;
  artifactRevision: string;
  approvalReceipt?: ApprovalReceipt;
  /** Exact UI revision accepted before this functional handoff, if any. */
  uiRevision?: string;
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

/**
 * A UI preview is source-first. The Browser HTML is a renderer output, never
 * the authored design input.  Keeping the small source set in durable state
 * lets a later functionality pass promote the exact reviewed UI.
 */
export type UiPreviewRevision = {
  appId: string;
  revision: string;
  sourceDigest: string;
  catalogDigest: string;
  sourceSha: string;
  sourceTree: string;
  routes: readonly string[];
  files: readonly { path: string; content: string }[];
  catalogGaps: readonly { path: string; reason: string }[];
  previewHtml: string;
  createdByCallId: string;
};

type TargetExecutionBinding = {
  sourceSha: string;
  sourceTree: string;
  sourceReceiptDigest: string;
  eligibilityDigest: string;
  workspaceDigest: string;
  imageDigest: string;
  dependencyCacheDigest: string;
  appSpecDigest: string;
  artifactRevision: string;
};

export type DependencyPreparationReceipt = TargetExecutionBinding & {
  version: 2;
  targetSha: string;
  targetTree: string;
  cacheManifestDigest: string;
  cacheContentDigest: string;
  dependencyLayout: ExecutionDependencyLayout;
  preparedByCallId: string;
  digest: string;
};

/** Reject persisted V2 receipts whose durable fields no longer bind together. */
export function assertExactDependencyPreparationReceipt(
  receipt: DependencyPreparationReceipt,
): void {
  const { digest, ...unsigned } = receipt;
  if (
    receipt.version !== 2 ||
    receipt.dependencyLayout === undefined ||
    !/^[0-9a-f]{64}$/u.test(digest) ||
    digest !== sha256(JSON.stringify(unsigned))
  )
    throw new Error("The dependency preparation receipt is malformed.");
}

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
  githubSource?: ImmutableGitHubSourceReceipt;
  preparedByCallId: string;
  artifacts: readonly PrototypeArtifact[];
};

type UiPreviewPhase = WorkspacePhase & { uiPreview: UiPreviewRevision };

export type GitHubDraftProposalBinding = {
  proposal: DraftPullRequestProposal;
  sourceReceiptDigest: string;
  githubSourceDigest: string;
};

type ReviewedPhase = WorkspacePhase & {
  appSpec: AcceptedAppSpec;
  dependencyReceipt: DependencyPreparationReceipt;
  identityReceipt: TargetIdentityReceipt;
  proposal: AppCreationProposal;
  applyReceipt: TargetApplyReceipt;
  validationReceipt: TargetValidationReceipt;
  reviewReceipt: ReviewedChangeSetReceipt;
  githubDraftProposal?: GitHubDraftProposalBinding;
};

export type AppBuilderWorkflowState =
  | { version: typeof APP_BUILDER_WORKFLOW_VERSION; phase: "empty" }
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "prepared";
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "ui_previewed";
    } & UiPreviewPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "ui_accepted";
      uiAcceptedByCallId: string;
    } & UiPreviewPhase)
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
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "fresh_bootstrap_pending";
      freshBootstrapProposal: FreshBootstrapProposal;
      freshBootstrapCallId: string;
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "fresh_bootstrap_failed";
      freshBootstrapReceipt: FreshBootstrapFailureReceipt;
    } & ReviewedPhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "published_fresh_bootstrap";
      freshBootstrapReceipt: FreshBootstrapSuccessReceipt;
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
      | "published_branch_worktree"
      | "fresh_bootstrap_pending"
      | "fresh_bootstrap_failed"
      | "published_fresh_bootstrap";
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
    state.phase === "published_branch_worktree" ||
    state.phase === "fresh_bootstrap_pending" ||
    state.phase === "fresh_bootstrap_failed" ||
    state.phase === "published_fresh_bootstrap"
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

export function assertCurrentGitHubDraftProposal(input: {
  binding: GitHubDraftProposalBinding | undefined;
  expectedProposalDigest: string;
  reviewDigest: string;
  changeSetDigest: string;
  sourceReceiptDigest: string;
  githubSource: ImmutableGitHubSourceReceipt;
}): DraftPullRequestProposal {
  const binding = input.binding;
  const proposal = binding?.proposal;
  if (
    binding === undefined ||
    proposal === undefined ||
    proposal.digest !== input.expectedProposalDigest ||
    proposal.reviewDigest !== input.reviewDigest ||
    proposal.changeSetDigest !== input.changeSetDigest ||
    binding.sourceReceiptDigest !== input.sourceReceiptDigest ||
    binding.githubSourceDigest !== input.githubSource.digest ||
    proposal.repositoryId !== input.githubSource.repository.repositoryId ||
    proposal.owner !== input.githubSource.repository.owner ||
    proposal.name !== input.githubSource.repository.name ||
    proposal.baseBranch !== input.githubSource.repository.defaultBranch
  )
    throw new Error(
      "The draft pull-request proposal is not the exact proposal sealed for this reviewed workflow.",
    );
  return proposal;
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

export function assertFreshBootstrapJournalStatus(
  phase:
    | "reviewed"
    | "fresh_bootstrap_pending"
    | "fresh_bootstrap_failed"
    | "published_fresh_bootstrap",
  status: "pending" | "failed" | "succeeded" | undefined,
): void {
  const allowed: Record<typeof phase, readonly (typeof status)[]> = {
    reviewed: [undefined, "pending", "failed"],
    fresh_bootstrap_pending: ["pending", "failed", "succeeded"],
    fresh_bootstrap_failed: ["failed", "succeeded"],
    published_fresh_bootstrap: ["succeeded"],
  };
  if (!allowed[phase].includes(status))
    throw new Error(
      `Workflow phase ${phase} cannot be paired with fresh-bootstrap journal ${status ?? "absent"}.`,
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
  APP_BUILDER_WORKFLOW_STATE_KEY,
  () => ({ version: APP_BUILDER_WORKFLOW_VERSION, phase: "empty" }),
);

/**
 * The only write gateway for agent tools. It preserves the optimistic-concurrency
 * guard while making transition ownership explicit at the workflow boundary.
 */
export function updateExactWorkflow(input: {
  expected: AppBuilderWorkflowState;
  operation: string;
  transition: (current: AppBuilderWorkflowState) => AppBuilderWorkflowState;
}): void {
  appBuilderWorkflowState.update((current) => {
    assertExactWorkflowState(current, input.expected, input.operation);
    return input.transition(current);
  });
}
