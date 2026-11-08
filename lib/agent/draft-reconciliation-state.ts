import type { OriginalPublicationRepair } from "../repository/owned-draft-composition";
import type { CandidateDependencyCatalogIntent } from "../repository/candidate-dependency-catalog";
import { defineState } from "eve/context";
import type { PublishedDraftRepairSource } from "./published-draft-repair";
import type { PublishedDraftRepairReview } from "../repository/published-draft-repair-review";
import type { ExistingDraftUpdateProposal } from "../repository/github-draft-update";
import { isDeepStrictEqual } from "node:util";
import type { OperatorArtifactContext } from "../provisioning/hosted-operator-artifact-store";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import type { PrivateApplyScope } from "./private-apply-authority";
import type { PublishedAppSourceReview } from "./published-app-source";
import type { ValidationLogReference } from "../repository/validation-log";
import type { DraftReviewedWorkflow } from "./draft-reviewed-lineage";

import type {
  ExistingDraftReconciliationProposal,
  OwnedPublicationReconciliationScope,
  ReconciliationReviewReceipt,
} from "../repository/github-draft-reconciliation";

/** Only metadata from an acknowledged, owner-bound artifact capture; never source or SQL bytes. */
export interface ReconciliationCompilation {
  context: OperatorArtifactContext;
  privateApplyScope?: PrivateApplyScope;
  release:
    | { status: "not-required" }
    | { status: "published"; selection: Omit<CompiledOperatorReleaseSelection, "publishedSource"> };
}

/** Sealing precedes the publication approval checkpoint. Edits never replace this context. */
export interface DraftReconciliationCompletion {
  preparation: "sealed-before-approval" | "legacy-recording-only";
  proposal: ExistingDraftReconciliationProposal;
  review: ReconciliationReviewReceipt;
  /** Original applied change-set lineage, not an independent assessment of the merged candidate. */
  appReview: PublishedAppSourceReview;
  appId: string;
  githubSourceDigest: string;
  publishedOrigin?: PublishedDraftRepairSource;
  publicationScope?: OwnedPublicationReconciliationScope;
  root: string;
  compilation: ReconciliationCompilation;
}

export const draftReconciliationCompletions = defineState<DraftReconciliationCompletion[]>(
  "autograph-app-builder.draft-reconciliation-completions.v1",
  () => [],
);

export const retainDraftReconciliationCompletion = (
  completion: DraftReconciliationCompletion,
): void => {
  draftReconciliationCompletions.update((current) => {
    const prior = current.find((entry) => entry.proposal.digest === completion.proposal.digest);
    if (prior !== undefined) {
      if (!isDeepStrictEqual({ ...prior, preparation: completion.preparation }, completion)) {
        throw new Error(
          "The retained publication completion belongs to different approved context.",
        );
      }
      return completion.preparation === "sealed-before-approval"
        ? current.map((entry) => (entry === prior ? completion : entry))
        : current;
    }
    return [...current, completion];
  });
};

export const assertRetainedDraftReconciliationCompletion = (
  completion: DraftReconciliationCompletion,
): void => {
  if (!draftReconciliationCompletions.get().some((entry) => isDeepStrictEqual(entry, completion))) {
    throw new Error(
      "completion_context_missing: The original approved publication context is unavailable.",
    );
  }
};

/** Owned private work retained for comparison; it grants no replay or publication authority. */
export interface PreservedDraftWorkspace {
  kind: "app-review" | "draft-candidate";
  root: string;
  reviewDigest: string;
  paths?: readonly string[];
}

interface DraftCandidateFields {
  originalPublicationRepair?: OriginalPublicationRepair;
  /** Original complete app review, retained independently from creation-workspace revalidation. */
  reviewedLineage?: DraftReviewedWorkflow;
  dependencyCatalogPending?: CandidateDependencyCatalogIntent;
  version: 1;
  appId: string;
  githubSourceDigest: string;
  originalReviewDigest: string;
  repositoryId: string;
  pullRequestNumber: number;
  root: string;
  workspaceRoot: string;
  headSha: string;
  headTree: string;
  baseSha: string;
  baseTree: string;
  conflicts: readonly string[];
  /** Server-produced exact catalog normalization, scoped to this retained candidate. */
  dependencyCatalog?: {
    files: readonly { path: string; digest: string }[];
    nonAppIndexDigest: string;
  };
  recoveryMode?: "reopen-current-owned-draft";
  preservedWorkspaces?: readonly PreservedDraftWorkspace[];
  validation?: {
    resolvedTree: string;
    commands: readonly { command: string; exitCode: number }[];
    validatedByCallId: string;
    compilation?: ReconciliationCompilation;
  };
  validationRun?: {
    steps: readonly {
      // oxlint-disable-next-line sonarjs/max-union-size -- Each command category has distinct execution handling.
      kind: "install" | "schema" | "local" | "check" | "browser" | "additional" | "capture";
      /** A fixed setup action selected by an actual failed repository command. */
      recoveryFor?: string;
      command: string;
    }[];
    nextIndex: number;
    /** Acknowledged successful selected-app compile in this coherent validation pass. */
    schemaTaskCompleted?: true;
    compilation?: ReconciliationCompilation;
    commands: readonly { command: string; exitCode: number }[];
    resolvedTree: string;
  };
  review?: ReconciliationReviewReceipt;
  reviewReadProgress?: {
    reviewDigest: string;
    baseNextCursor: number | null;
    headNextCursor: number | null;
    baseComplete: boolean;
    headComplete: boolean;
  };
  proposal?: ExistingDraftReconciliationProposal;
  /** Last provider-proved approved merge, independent of the current unpublished candidate. */
  publishedReconciliation?: ExistingDraftReconciliationProposal;
}

/** Repair comparison base is its draft head; it is never represented as live main. */
export type DraftReconciliationCandidate = DraftCandidateFields &
  (
    | {
        kind?: "reconciliation";
        repair?: never;
        repairReview?: never;
        publishedOrigin?: PublishedDraftRepairSource;
        publicationScope?: OwnedPublicationReconciliationScope;
      }
    | {
        kind: "published-draft-repair";
        repair: PublishedDraftRepairSource;
        repairReview?: PublishedDraftRepairReview;
        publishedOrigin?: never;
        publicationScope?: never;
      }
  );

export interface PublishedDraftRepairCompletion {
  kind: "published-draft-repair";
  proposal: ExistingDraftUpdateProposal;
  review: PublishedDraftRepairReview;
  appReview: PublishedAppSourceReview;
  appId: string;
  root: string;
  repair: PublishedDraftRepairSource;
  compilation: ReconciliationCompilation;
}

export const publishedDraftRepairCompletions = defineState<PublishedDraftRepairCompletion[]>(
  "autograph-app-builder.published-draft-repair-completions.v1",
  () => [],
);
export const retainPublishedDraftRepairCompletion = (
  completion: PublishedDraftRepairCompletion,
): void => {
  publishedDraftRepairCompletions.update((current) => {
    const prior = current.find((entry) => entry.proposal.digest === completion.proposal.digest);
    if (prior !== undefined && !isDeepStrictEqual(prior, completion)) {
      throw new Error(
        "The retained draft repair completion belongs to different approved context.",
      );
    }
    return prior === undefined ? [...current, completion] : current;
  });
};
export const assertRetainedPublishedDraftRepairCompletion = (
  completion: PublishedDraftRepairCompletion,
): void => {
  if (
    !publishedDraftRepairCompletions.get().some((entry) => isDeepStrictEqual(entry, completion))
  ) {
    throw new Error("The exact retained draft repair completion is unavailable.");
  }
};
export type DraftPublicationCompletion =
  | DraftReconciliationCompletion
  | PublishedDraftRepairCompletion;

export interface CandidateValidationAttempt {
  attemptDigest: string;
  appId: string;
  baseSha: string;
  callId: string;
  // oxlint-disable-next-line sonarjs/max-union-size -- Persisted command categories distinguish the supported diagnostic readback forms.
  category: "check-build" | "test" | "local-preparation" | "additional-check";
  command: string;
  completion: "complete" | "interrupted" | "unavailable";
  durability: "available" | "unavailable";
  exitCode: number | null;
  githubSourceDigest: string;
  headSha: string;
  logs: Partial<Record<"stdout" | "stderr", ValidationLogReference>>;
  originalReviewDigest: string;
  pullRequestNumber: number;
  repositoryId: string;
  resolvedTree: string;
}

export const draftReconciliationState = defineState<DraftReconciliationCandidate | null>(
  "autograph-app-builder.draft-reconciliation.v1",
  () => null,
);

/** Historical command evidence survives resets of the current candidate validation run. */
export const candidateValidationAttemptHistory = defineState<CandidateValidationAttempt[]>(
  "autograph-app-builder.draft-reconciliation-validation-attempts.v1",
  () => [],
);

export const retainCandidateValidationAttempt = (attempt: CandidateValidationAttempt): void => {
  candidateValidationAttemptHistory.update((current) => [...current, attempt]);
};

/** Compare the durable JSON value, ignoring object-key order and omitted undefined fields. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- The JSON-normalized value is used only for equality, never as a typed candidate.
const storedDraftCandidate = (candidate: DraftReconciliationCandidate | null): unknown => {
  const serialized = JSON.stringify(candidate);
  return JSON.parse(serialized);
};
export const samePersistedDraftCandidate = (
  left: DraftReconciliationCandidate | null,
  right: DraftReconciliationCandidate | null,
): boolean => isDeepStrictEqual(storedDraftCandidate(left), storedDraftCandidate(right));

export const updateExactDraftReconciliation = (input: {
  expected: DraftReconciliationCandidate | null;
  operation: string;
  transition: (current: DraftReconciliationCandidate | null) => DraftReconciliationCandidate | null;
}): void => {
  draftReconciliationState.update((current) => {
    if (!samePersistedDraftCandidate(current, input.expected)) {
      throw new Error(
        `The draft reconciliation changed while Builder was ${input.operation}. Inspect its current state, then retry.`,
      );
    }
    return input.transition(current);
  });
};
