import { defineState } from "eve/context";

import type {
  ExistingDraftReconciliationProposal,
  ReconciliationReviewReceipt,
} from "../repository/github-draft-reconciliation";

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
  };
  validationRun?: {
    steps: readonly {
      // oxlint-disable-next-line sonarjs/max-union-size -- Each command category has distinct execution handling.
      kind: "install" | "schema" | "local" | "check" | "browser" | "additional";
      command: string;
    }[];
    nextIndex: number;
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
}

export const draftReconciliationState = defineState<DraftReconciliationCandidate | null>(
  "autograph-app-builder.draft-reconciliation.v1",
  () => null,
);

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
