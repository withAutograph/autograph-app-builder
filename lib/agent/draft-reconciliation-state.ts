import { defineState } from "eve/context";
import { isDeepStrictEqual } from "node:util";
import type { OperatorArtifactContext } from "../provisioning/hosted-operator-artifact-store";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import type { PrivateApplyScope } from "./private-apply-authority";
import type { PublishedAppSourceReview } from "./published-app-source";
import type { ValidationLogReference } from "../repository/validation-log";

import type {
  ExistingDraftReconciliationProposal,
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
  appReview: PublishedAppSourceReview;
  appId: string;
  githubSourceDigest: string;
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

export interface DraftReconciliationCandidate {
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
  validation?: {
    resolvedTree: string;
    commands: readonly { command: string; exitCode: number }[];
    validatedByCallId: string;
    compilation?: ReconciliationCompilation;
  };
  validationRun?: {
    steps: readonly {
      // oxlint-disable-next-line sonarjs/max-union-size -- Each command category has distinct execution handling.
      kind: "install" | "schema" | "local" | "check" | "browser" | "additional";
      command: string;
    }[];
    nextIndex: number;
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

export interface CandidateValidationAttempt {
  attemptDigest: string;
  appId: string;
  baseSha: string;
  callId: string;
  category: "check-build" | "test";
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

export const updateExactDraftReconciliation = (input: {
  expected: DraftReconciliationCandidate | null;
  operation: string;
  transition: (current: DraftReconciliationCandidate | null) => DraftReconciliationCandidate | null;
}): void => {
  draftReconciliationState.update((current) => {
    if (JSON.stringify(current) !== JSON.stringify(input.expected)) {
      throw new Error(
        `The draft reconciliation changed while Builder was ${input.operation}. Inspect its current state, then retry.`,
      );
    }
    return input.transition(current);
  });
};
