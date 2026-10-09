import { describe, expect, it } from "vitest";

import {
  invalidateGitHubDestinationReview,
  assertCompleteGitHubDestinationReview,
  assertExactWorkflowState,
  APP_BUILDER_WORKFLOW_VERSION,
} from "./workflow-state";
import { createGitHubDestinationReviewBinding } from "../repository/github-destination-review";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
} from "../repository/github-publication";

const installation = createGitHubInstallationIdentity({
  accountId: "20",
  accountLogin: "withAutograph",
  accountType: "Organization",
  installationId: "10",
  operation: "resolve-existing-source",
  repositorySelection: "selected",
  selectedRepositoryIds: ["100"],
});
const repository = createRepositoryObservation({
  defaultBranch: "main",
  headSha: "1".repeat(40),
  headTree: "2".repeat(40),
  installationIdentityDigest: installation.digest,
  name: "example",
  owner: "withAutograph",
  releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
  repositoryId: "100",
  visibility: "private",
});
const binding = createGitHubDestinationReviewBinding({
  applyDigest: "apply",
  candidatePaths: ["apps/example/schema/index.ts"],
  installation,
  postTreeDigest: "post",
  preTree: [],
  repository,
  validationDigest: "validation",
});

describe("initial draft destination review workflow", () => {
  it("preserves validated bytes and original provenance while invalidating old review authority", () => {
    const original = {
      applyReceipt: { applyRoot: "/workspace/private-validated-app", digest: "apply" },
      githubDestinationReviewRead: {
        afterComplete: true,
        beforeComplete: true,
        changeSetDigest: "old",
      },
      githubDraftProposal: { digest: "old-proposal" },
      phase: "reviewed" as const,
      reviewReceipt: { digest: "old-review" },
      sourceReceipt: { sourceSha: "79952fedea119831cc30beab504d3d7d6b271209" },
      validationReceipt: { digest: "validation" },
    };
    const refreshed = invalidateGitHubDestinationReview(original, binding);
    expect(refreshed).toMatchObject({
      applyReceipt: original.applyReceipt,
      githubDestinationReview: binding,
      phase: "validated",
      sourceReceipt: original.sourceReceipt,
      validationReceipt: original.validationReceipt,
    });
    expect(refreshed).not.toHaveProperty("reviewReceipt");
    expect(refreshed).not.toHaveProperty("githubDraftProposal");
    expect(refreshed).not.toHaveProperty("githubDestinationReviewRead");
    expect(original).toHaveProperty("reviewReceipt.digest", "old-review");
  });

  it("requires complete fresh before and after reads for the exact accepted destination diff", () => {
    expect(() => {
      assertCompleteGitHubDestinationReview(undefined, "new-review");
    }).toThrow("both complete sides");
    const partial = { afterComplete: false, beforeComplete: true, changeSetDigest: "new-review" };
    expect(() => {
      assertCompleteGitHubDestinationReview(partial, "new-review");
    }).toThrow("both complete sides");
    const complete = { ...partial, afterComplete: true };
    expect(() => {
      assertCompleteGitHubDestinationReview(complete, "changed-review");
    }).toThrow("both complete sides");
    expect(() => {
      assertCompleteGitHubDestinationReview(complete, "new-review");
    }).not.toThrow();
  });

  it("retains the exact workflow concurrency guard used by destination preparation", () => {
    const expected = { phase: "empty" as const, version: APP_BUILDER_WORKFLOW_VERSION };
    expect(() => {
      assertExactWorkflowState(expected, expected, "destination review preparation");
    }).not.toThrow();
    const concurrent = { ...expected, pendingOperation: "another continuation" };
    expect(() => {
      assertExactWorkflowState(concurrent, expected, "destination review preparation");
    }).toThrow("changed concurrently");
  });
});
