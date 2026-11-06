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
        commands: validation.commands.map(({ command, exitCode }) => ({ command, exitCode })),
        resolvedTree: validation.resolvedTree,
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
