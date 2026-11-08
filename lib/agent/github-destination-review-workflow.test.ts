import { initialDraftCandidatePaths } from "../../agent/tools/prepare_github_draft_review";
import { describe, expect, it } from "vitest";

import {
  invalidateGitHubDestinationReview,
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

const originalDestinationFiles = () =>
  Promise.resolve(
    (
      [
        ["microfrontends.json", "old-routes"],
        ["bun.lock", "old-lock"],
        ["package.json", "same-root"],
      ] as const
    ).map(([path, sha256]) => ({
      path,
      sha256,
      mode: "100644" as const,
      objectId: "blob",
    })),
  );

describe("initial draft destination review workflow", () => {
  it("includes the complete new app and retained registration after a narrow repair", async () => {
    const files = (
      [
        ["apps/example/package.json", "manifest"],
        ["apps/example/app/page.tsx", "page"],
        ["apps/example/app/actions.ts", "repair"],
        ["apps/example/.next/build.js", "output"],
        ["apps/unrelated/package.json", "unrelated"],
        ["microfrontends.json", "new-routes"],
        ["bun.lock", "new-lock"],
        ["package.json", "same-root"],
      ] as const
    ).map(([path, digest]) => ({ path, digest, mode: "644" }));
    // SAFETY: This path-selection test supplies all workflow fields the helper reads.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial workflow fixture.
    const input = {
      observed: { files, treeDigest: "current" },
      reviewedPaths: ["apps/example/app/actions.ts"],
      state: {
        appSpec: { appId: "example" },
        applyReceipt: { targetReceipt: { topology: { path: "microfrontends.json" } } },
        sourceReceipt: { sourceKind: "fresh-template" },
        workspace: {},
      },
      sandbox: {},
    } as never;
    const result = await initialDraftCandidatePaths(input, originalDestinationFiles);
    expect(result.candidatePaths.toSorted()).toEqual([
      "apps/example/app/actions.ts",
      "apps/example/app/page.tsx",
      "apps/example/package.json",
      "bun.lock",
      "microfrontends.json",
    ]);
    expect([...result.retainedRegistration]).toEqual([
      ["microfrontends.json", "old-routes"],
      ["bun.lock", "old-lock"],
    ]);
  });

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

  it("allows only observational destination read progress to change during a workflow operation", () => {
    const expected = {
      phase: "empty" as const,
      version: APP_BUILDER_WORKFLOW_VERSION,
      sourceReceipt: { sourceSha: "original" },
      approvalReceipt: { digest: "approved" },
    };
    const observed = {
      ...expected,
      githubDestinationReviewRead: {
        afterComplete: false,
        beforeComplete: true,
        changeSetDigest: "observed-diff",
      },
    };
    expect(() => {
      assertExactWorkflowState(observed, expected, "acceptance");
      assertExactWorkflowState(expected, observed, "acceptance");
    }).not.toThrow();
    expect(observed.githubDestinationReviewRead.afterComplete).toBe(false);
    const changedSource = { ...observed, sourceReceipt: { sourceSha: "changed" } };
    expect(() => {
      assertExactWorkflowState(changedSource, expected, "acceptance");
    }).toThrow("changed concurrently");
    const changedApproval = { ...observed, approvalReceipt: { digest: "different approval" } };
    expect(() => {
      assertExactWorkflowState(changedApproval, expected, "acceptance");
    }).toThrow("changed concurrently");
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
