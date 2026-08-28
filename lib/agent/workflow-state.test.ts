import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  APP_BUILDER_WORKFLOW_STATE_KEY,
  assertCurrentGitHubDraftProposal,
  assertExactWorkflowState,
  assertFreshBootstrapJournalStatus,
  assertPublicationJournalStatus,
  assertUpstreamMutationAllowed,
  type AppBuilderWorkflowState,
  type GitHubDraftProposalBinding,
} from "./workflow-state";
import type {
  DraftPullRequestProposal,
  ImmutableGitHubSourceReceipt,
} from "@/lib/repository/github-publication";

const state = (phase: AppBuilderWorkflowState["phase"]) =>
  ({
    version: APP_BUILDER_WORKFLOW_VERSION,
    phase,
  }) as AppBuilderWorkflowState;

describe(`workflow V${APP_BUILDER_WORKFLOW_VERSION} aggregate boundary`, () => {
  const githubSource = {
    digest: "1".repeat(64),
    repository: {
      repositoryId: "1234",
      owner: "withAutograph",
      name: "arrusted-development",
      defaultBranch: "main",
    },
    resolvedSha: "a".repeat(40),
    resolvedTree: "b".repeat(40),
  } as ImmutableGitHubSourceReceipt;
  const proposal = {
    digest: "2".repeat(64),
    reviewDigest: "3".repeat(64),
    changeSetDigest: "4".repeat(64),
    repositoryId: "1234",
    owner: "withAutograph",
    name: "arrusted-development",
    baseBranch: "main",
    baseSha: githubSource.resolvedSha,
    baseTree: githubSource.resolvedTree,
  } as DraftPullRequestProposal;
  const binding: GitHubDraftProposalBinding = {
    proposal,
    sourceReceiptDigest: "5".repeat(64),
    githubSourceDigest: githubSource.digest,
  };
  const exactProposalInput = {
    binding,
    expectedProposalDigest: proposal.digest,
    reviewDigest: proposal.reviewDigest,
    changeSetDigest: proposal.changeSetDigest,
    sourceReceiptDigest: binding.sourceReceiptDigest,
    githubSource,
  };

  it("uses a new durable key so earlier aggregates cannot be reinterpreted", () => {
    expect(APP_BUILDER_WORKFLOW_STATE_KEY).toBe(
      `autograph-app-builder.workflow.v${APP_BUILDER_WORKFLOW_VERSION}`,
    );
    expect(APP_BUILDER_WORKFLOW_STATE_KEY).not.toMatch(
      /workflow\.v(?:9|10|11)$/u,
    );
  });

  it.each([
    "publication_pending",
    "publication_failed",
    "published_local",
    "branch_publication_pending",
    "branch_publication_failed",
    "published_branch_worktree",
    "fresh_bootstrap_pending",
    "fresh_bootstrap_failed",
    "published_fresh_bootstrap",
  ] as const)("rejects upstream mutation in %s", (phase) => {
    expect(() =>
      assertUpstreamMutationAllowed(state(phase), "test mutation"),
    ).toThrow(/permanently disabled/u);
  });

  it.each([
    ["reviewed", [undefined, "pending", "failed"]],
    ["fresh_bootstrap_pending", ["pending", "failed", "succeeded"]],
    ["fresh_bootstrap_failed", ["failed", "succeeded"]],
    ["published_fresh_bootstrap", ["succeeded"]],
  ] as const)(
    "accepts canonical fresh-bootstrap %s windows",
    (phase, allowed) => {
      for (const journal of [
        undefined,
        "pending",
        "failed",
        "succeeded",
      ] as const) {
        const assertion = () =>
          assertFreshBootstrapJournalStatus(phase, journal);
        if ((allowed as readonly unknown[]).includes(journal))
          expect(assertion).not.toThrow();
        else expect(assertion).toThrow(/cannot be paired/u);
      }
    },
  );

  it("rejects a stale update racing reviewed to publication pending", () => {
    expect(() =>
      assertExactWorkflowState(
        state("publication_pending"),
        state("reviewed"),
        "prototype artifact recording",
      ),
    ).toThrow(/changed concurrently/u);
  });

  it("accepts only the proposal sealed into the current reviewed workflow", () => {
    expect(assertCurrentGitHubDraftProposal(exactProposalInput)).toBe(proposal);
  });

  it("rejects an old proposal after a new review without provider mutation", () => {
    expect(() =>
      assertCurrentGitHubDraftProposal({
        ...exactProposalInput,
        reviewDigest: "6".repeat(64),
      }),
    ).toThrow(/not the exact proposal/u);
  });

  it("rejects cross-session proposal adoption through a different source binding", () => {
    expect(() =>
      assertCurrentGitHubDraftProposal({
        ...exactProposalInput,
        githubSource: {
          ...githubSource,
          digest: "7".repeat(64),
        },
      }),
    ).toThrow(/not the exact proposal/u);
  });

  it.each([
    ["reviewed", [undefined]],
    ["publication_pending", [undefined, "pending", "failed", "succeeded"]],
    ["publication_failed", [undefined, "failed"]],
    ["published_local", ["succeeded"]],
  ] as const)("accepts canonical %s transaction windows", (phase, allowed) => {
    for (const journal of [
      undefined,
      "pending",
      "failed",
      "succeeded",
    ] as const) {
      const assertion = () => assertPublicationJournalStatus(phase, journal);
      if ((allowed as readonly unknown[]).includes(journal))
        expect(assertion).not.toThrow();
      else expect(assertion).toThrow(/cannot be paired/u);
    }
  });

  it("requires every upstream mutator to use the aggregate guard", async () => {
    const tools = [
      "prepare_workspace",
      "record_prototype_artifact",
      "accept_app_spec",
      "prepare_target_dependencies",
      "plan_app_creation",
      "apply_app_creation",
      "validate_app_creation",
      "accept_change_set",
      "target_execution_status",
      "workspace_readiness_status",
    ];
    for (const tool of tools) {
      const source = await readFile(
        resolve(process.cwd(), `agent/tools/${tool}.ts`),
        "utf8",
      );
      expect(source, tool).toMatch(
        /assertUpstreamMutationAllowed\(\s*(?:current|state),/u,
      );
    }
  });
});
