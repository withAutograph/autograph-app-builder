import { createHash } from "node:crypto";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type {
  DraftReconciliationCandidate,
  DraftPublicationCompletion,
} from "./draft-reconciliation-state";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import {
  assertPublishedDraftRepairSource,
  reviewedDraftCandidateSource,
} from "./published-draft-repair-source";
import type { PublishedDraftRepairSource } from "./published-draft-repair-source";

export {
  assertPublishedDraftRepairSource,
  createPublishedDraftRepairSource,
} from "./published-draft-repair-source";
export type { PublishedDraftRepairSource } from "./published-draft-repair-source";

export const draftCandidateValidationDigest = (
  validation: NonNullable<DraftReconciliationCandidate["validation"]>,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        resolvedTree: validation.resolvedTree,
        commands: validation.commands.map(({ command, exitCode }) => ({ command, exitCode })),
        validatedByCallId: validation.validatedByCallId,
      }),
    )
    .digest("hex");

/** One authority predicate for every candidate consumer, including compiled source capture. */
export const currentDraftCandidateSource = (
  workflow: AppBuilderWorkflowState,
  candidate: DraftReconciliationCandidate | null,
): ImmutableGitHubSourceReceipt | undefined => {
  const state = resolveDraftReviewedWorkflow(workflow, candidate);
  return state === undefined || candidate === null
    ? undefined
    : reviewedDraftCandidateSource(state, candidate);
};

const publishedOriginInstallation = (origin: PublishedDraftRepairSource | undefined) => {
  if (origin === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep the optional selected-installation return explicit on both branches.
    return undefined;
  }
  assertPublishedDraftRepairSource(origin);
  return { selectedInstallationId: origin.installationId };
};

export const draftCandidateInstallation = (candidate: DraftReconciliationCandidate) =>
  publishedOriginInstallation(
    candidate.kind === "published-draft-repair" ? candidate.repair : candidate.publishedOrigin,
  );

export const draftCompletionInstallation = (completion: DraftPublicationCompletion) =>
  publishedOriginInstallation(
    "kind" in completion ? completion.repair : completion.publishedOrigin,
  );

/** Recover a publication lookup from the same accepted app, never its old review approval. */
export const retainedPublishedDraftOriginForReview = (
  state: Extract<AppBuilderWorkflowState, { phase: "reviewed" }>,
  candidate: DraftReconciliationCandidate | null,
): PublishedDraftRepairSource | undefined => {
  const retained = candidate?.reviewedLineage;
  if (
    state.publishedGitHubDraftProposalDigest !== undefined ||
    candidate === null ||
    retained === undefined ||
    retained.phase !== "reviewed" ||
    state.sourceReceipt.sourceKind !== "fresh-template" ||
    state.githubSource !== undefined
  ) {
    return undefined;
  }
  try {
    if (reviewedDraftCandidateSource(retained, candidate) === undefined) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const origin =
    candidate.kind === "published-draft-repair" ? candidate.repair : candidate.publishedOrigin;
  const matches = [
    state.appSpec.appId === retained.appSpec.appId,
    state.appSpec.digest === retained.appSpec.digest,
    state.sourceReceipt.digest === retained.sourceReceipt.digest,
    state.workspace.workspaceId === retained.workspace.workspaceId,
    state.workspace.workspacePath === retained.workspace.workspacePath,
    state.workspace.workspaceDigest === retained.workspace.workspaceDigest,
    state.workspace.sourceSha === retained.workspace.sourceSha,
    state.workspace.sourceTree === retained.workspace.sourceTree,
    state.applyReceipt.applyRoot === retained.applyReceipt.applyRoot,
  ].every(Boolean);
  return matches ? origin : undefined;
};
