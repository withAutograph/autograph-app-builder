import { assertExactImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { SourceWorkflowState } from "./source-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { repositoryAccessReceiptSchema } from "./repository-access-state";
import type { RepositoryAccessReceipt } from "./repository-access-state";
import { parseSourceReceipt } from "../repository/source-receipt";
import { selectedGitHubSourceForSandboxRestore } from "./restore-selected-github-sandbox-source";

type BindingStage = "prepare-workspace" | "resolve-source-state" | "resolve-workflow-state";
export interface SavedGitHubBindingDiagnostics {
  acceptedBindingPresent: boolean;
  accessReceiptPresent: boolean;
  accessScopeMatches: boolean;
  providerWorkspaceMatches: boolean;
  resolutionCallMatches: boolean;
  savedSnapshotMatches: boolean;
  sourceBindingPresent: boolean;
  sourceReceiptMatches: boolean;
  stage: BindingStage;
}
export class SavedGitHubBindingError extends Error {
  readonly code = "saved_github_binding_provenance_unavailable";
  readonly diagnostics: SavedGitHubBindingDiagnostics;
  constructor(diagnostics: SavedGitHubBindingDiagnostics) {
    super(
      "The saved app's GitHub binding is missing and its original source provenance could not be verified. Restore this same app's recorded source and repository access; no replacement repository or app was selected.",
    );
    this.diagnostics = diagnostics;
    this.name = "SavedGitHubBindingError";
    console.warn(
      "app_builder.github_source_binding_guard",
      JSON.stringify({ code: this.code, ...diagnostics }),
    );
  }
}

export const throwSavedBindingGuard = (
  workflow: AppBuilderWorkflowState,
  source: SourceWorkflowState,
  stage: BindingStage,
): never => {
  throw new SavedGitHubBindingError({
    acceptedBindingPresent: workflow.phase !== "empty" && workflow.githubSource !== undefined,
    accessReceiptPresent: false,
    accessScopeMatches: false,
    providerWorkspaceMatches: false,
    resolutionCallMatches: false,
    savedSnapshotMatches: false,
    sourceBindingPresent: source.phase !== "empty" && source.githubSource !== undefined,
    sourceReceiptMatches:
      source.phase !== "empty" &&
      workflow.phase !== "empty" &&
      source.receipt.digest === workflow.sourceReceipt.digest,
    stage,
  });
};

interface SavedBindingRecovery {
  githubSource: ImmutableGitHubSourceReceipt | undefined;
  recovered: boolean;
  workflow: AppBuilderWorkflowState;
}
/** Only existing server-recorded source authority can recover a lost accepted-workflow slot. */
export const recoverSavedWorkflowGitHubBinding = (input: {
  access: RepositoryAccessReceipt | undefined;
  providerWorkspaceId?: string;
  sessionId: string;
  source: SourceWorkflowState;
  stage: BindingStage;
  workflow: AppBuilderWorkflowState;
}): SavedBindingRecovery => {
  const { source, workflow } = input;
  const sourceBinding = source.phase === "empty" ? undefined : source.githubSource;
  const acceptedBinding = workflow.phase === "empty" ? undefined : workflow.githubSource;
  const githubSource = selectedGitHubSourceForSandboxRestore({
    sourceState: sourceBinding,
    workflowState: acceptedBinding,
  });
  if (workflow.phase === "empty" || acceptedBinding !== undefined) {
    return { githubSource, recovered: false, workflow };
  }
  if (source.phase === "empty" || githubSource === undefined) {
    throwSavedBindingGuard(workflow, source, input.stage);
    return { githubSource, recovered: false, workflow };
  }
  const access = repositoryAccessReceiptSchema.safeParse(input.access);
  const accessScopeMatches =
    access.success &&
    [
      access.data.sessionId === input.sessionId,
      access.data.repository.repositoryId === githubSource.repository.repositoryId,
      access.data.repository.owner === githubSource.repository.owner,
      access.data.repository.name === githubSource.repository.name,
    ].every(Boolean);
  const savedSnapshotMatches = [
    workflow.sourceReceipt.sourceSha === githubSource.resolvedSha,
    workflow.sourceReceipt.sourceTree === githubSource.resolvedTree,
    workflow.workspace.sourceSha === workflow.sourceReceipt.sourceSha,
    workflow.workspace.sourceTree === workflow.sourceReceipt.sourceTree,
  ].every(Boolean);
  const sourceReceiptMatches = source.receipt.digest === workflow.sourceReceipt.digest;
  const resolutionCallMatches =
    access.success && access.data.confirmedByCallId === githubSource.resolvedByCallId;
  const providerWorkspaceMatches =
    input.providerWorkspaceId === undefined ||
    input.providerWorkspaceId === workflow.workspace.workspaceId;
  const diagnostics: SavedGitHubBindingDiagnostics = {
    acceptedBindingPresent: false,
    accessReceiptPresent: input.access !== undefined,
    accessScopeMatches,
    providerWorkspaceMatches,
    resolutionCallMatches,
    savedSnapshotMatches,
    sourceBindingPresent: true,
    sourceReceiptMatches,
    stage: input.stage,
  };
  if (
    ![
      accessScopeMatches,
      providerWorkspaceMatches,
      savedSnapshotMatches,
      sourceReceiptMatches,
      resolutionCallMatches,
    ].every(Boolean)
  ) {
    throw new SavedGitHubBindingError(diagnostics);
  }
  try {
    assertExactImmutableGitHubSourceReceipt(githubSource);
    parseSourceReceipt(workflow.sourceReceipt);
    parseSourceReceipt(source.receipt);
  } catch {
    throw new SavedGitHubBindingError({ ...diagnostics, sourceReceiptMatches: false });
  }
  console.info(
    "app_builder.github_source_binding_guard",
    JSON.stringify({ code: "saved_binding_recovered", ...diagnostics }),
  );
  return { githubSource, recovered: true, workflow: { ...workflow, githubSource } };
};
