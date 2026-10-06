import { describe, expect, it } from "vitest";

import {
  approvalReceiptSchema,
  approvalReceiptForExistingDraftUpdate,
  approvalRequestDecision,
  approvalTarget,
  approvalTargetFromDraftProposal,
  approvalTargetFromExistingDraftUpdate,
  approvalTargetFromExistingDraftReconciliation,
  approvalTargetFromGitHubSource,
  assertApprovalReceipt,
  publicApprovalDescription,
} from "./approval-receipt";
import type { ImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";

const receipt = {
  baseRef: "refs/heads/main",
  baseSha: "a".repeat(40),
  format: "autograph-eve-approval-receipt-v2" as const,
  outcome: "accept-appspec" as const,
  phase: "appspec" as const,
  repository: "withAutograph/arrusted-development",
  repositoryId: "1234",
  subjectDigest: "b".repeat(64),
};

describe("approval receipt", () => {
  it.each(["prepare-app-hosted-runtime", "cleanup-app-hosted-runtime"])(
    "does not describe %s approval without its frozen concrete resource plan",
    (tool) => {
      expect(
        publicApprovalDescription(
          {
            appId: "spend-review",
            branch: "preview",
            environment: "preview",
            projectId: "prj_services",
          },
          tool,
        ),
      ).toBeUndefined();
    },
  );
  const githubSource = {
    digest: "f".repeat(64),
    repository: {
      name: "arrusted-development",
      owner: "withAutograph",
      repositoryId: receipt.repositoryId,
    },
    resolvedRef: receipt.baseRef,
    resolvedSha: receipt.baseSha,
  } as ImmutableGitHubSourceReceipt;
  it("accepts one closed canonical receipt and its exact target", () => {
    expect(approvalReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(approvalTarget(receipt)).toEqual({
      baseRef: receipt.baseRef,
      baseSha: receipt.baseSha,
      repository: receipt.repository,
      repositoryId: receipt.repositoryId,
    });
    expect(
      assertApprovalReceipt({
        actual: receipt,
        phase: "appspec",
        subjectDigest: receipt.subjectDigest,
        target: approvalTarget(receipt),
      }),
    ).toEqual(receipt);
  });

  it("accepts SHA-256 repository object ids", () => {
    expect(
      approvalReceiptSchema.parse({ ...receipt, baseSha: "a".repeat(64) }).baseSha,
    ).toHaveLength(64);
  });

  it("requires separate approval for an existing draft PR and its exact branch head", () => {
    const proposal = {
      branchName: "app-builder/review-original",
      expectedHeadSha: "c".repeat(40),
      name: "arrusted-development",
      owner: "withAutograph",
      repositoryId: receipt.repositoryId,
    } as Parameters<typeof approvalTargetFromExistingDraftUpdate>[0];
    const target = approvalTargetFromExistingDraftUpdate(proposal);
    const updateReceipt = {
      ...receipt,
      baseRef: target.baseRef,
      baseSha: target.baseSha,
      outcome: "update-draft-pr" as const,
      phase: "draft_update" as const,
    };
    expect(() =>
      assertApprovalReceipt({
        actual: updateReceipt,
        phase: "draft_update",
        subjectDigest: receipt.subjectDigest,
        target,
      }),
    ).not.toThrow();
    expect(() =>
      assertApprovalReceipt({
        actual: { ...updateReceipt, baseSha: "d".repeat(40) },
        phase: "draft_update",
        subjectDigest: receipt.subjectDigest,
        target,
      }),
    ).toThrow("base commit");
    expect(
      publicApprovalDescription({ approvalReceipt: updateReceipt }, "update_github_draft_pr"),
    ).toBe(JSON.stringify(updateReceipt));
    expect(
      publicApprovalDescription({ approvalReceipt: updateReceipt }, "reconcile_github_draft_pr"),
    ).toContain("update the existing draft branch refs/heads/app-builder/review-original");
    expect(approvalTargetFromExistingDraftReconciliation(proposal)).toEqual(target);
    const generated = approvalReceiptForExistingDraftUpdate({
      ...proposal,
      digest: receipt.subjectDigest,
    });
    expect(generated).toEqual(updateReceipt);
    expect(generated.baseRef).not.toBe("refs/heads/main");
    expect(generated.baseSha).not.toBe(receipt.baseSha);
    expect(
      publicApprovalDescription({ approvalReceipt: updateReceipt }, "publish_github_draft_pr"),
    ).toBeUndefined();
  });

  it("binds draft publication approval to the proposal's current base, not the selected checkout", () => {
    const proposalTarget = approvalTargetFromDraftProposal({
      baseBranch: "main",
      baseSha: "d".repeat(40),
      name: "arrusted-development",
      owner: "withAutograph",
      repositoryId: receipt.repositoryId,
    });
    const publicationReceipt = {
      ...receipt,
      baseSha: proposalTarget.baseSha,
      outcome: "create-draft-pr" as const,
      phase: "publication" as const,
    };
    expect(proposalTarget.baseSha).not.toBe(githubSource.resolvedSha);
    expect(() => {
      assertApprovalReceipt({
        actual: publicationReceipt,
        phase: "publication",
        subjectDigest: receipt.subjectDigest,
        target: proposalTarget,
      });
    }).not.toThrow();
    expect(() => {
      assertApprovalReceipt({
        actual: publicationReceipt,
        phase: "publication",
        subjectDigest: receipt.subjectDigest,
        target: approvalTargetFromGitHubSource(githubSource),
      });
    }).toThrow("base commit");
    expect(
      publicApprovalDescription({ approvalReceipt: publicationReceipt }, "publish_github_draft_pr"),
    ).toBe(
      "This will publish the reviewed changes to a draft pull request in withAutograph/arrusted-development on main. The pull request will remain a draft; this will not merge or deploy it.",
    );
    expect(
      publicApprovalDescription({ approvalReceipt: receipt }, "publish_github_draft_pr"),
    ).toBeUndefined();
  });

  it("rejects extra keys, mismatched outcomes, targets, and subjects", () => {
    expect(() => approvalReceiptSchema.parse({ ...receipt, content: "private" })).toThrow();
    expect(() =>
      approvalReceiptSchema.parse({
        ...receipt,
        outcome: "accept_change_set",
      }),
    ).toThrow();
    expect(() =>
      assertApprovalReceipt({
        actual: receipt,
        phase: "appspec",
        subjectDigest: receipt.subjectDigest,
        target: { ...approvalTarget(receipt), repositoryId: "9999" },
      }),
    ).toThrow("does not match");
    expect(() =>
      assertApprovalReceipt({
        actual: receipt,
        phase: "appspec",
        subjectDigest: "c".repeat(64),
        target: approvalTarget(receipt),
      }),
    ).toThrow("does not match");
  });

  it("projects only the canonical receipt field", () => {
    expect(
      publicApprovalDescription({
        appSpec: "private",
        approvalReceipt: receipt,
        path: "/private/workspace",
      }),
    ).toBe(JSON.stringify(receipt));
    expect(
      publicApprovalDescription({
        approvalReceipt: { ...receipt, token: "secret" },
      }),
    ).toBeUndefined();
  });

  it("projects closed local AppSpec and change-set approval subjects", () => {
    expect(
      JSON.parse(
        publicApprovalDescription(
          {
            appId: "billing-console",
            expectedArtifactDigest: "1".repeat(64),
            expectedArtifactRevision: "2".repeat(64),
            expectedEligibilityDigest: "3".repeat(64),
            expectedSourceSha: "a".repeat(40),
            expectedSourceTree: "b".repeat(40),
            expectedWorkspaceDigest: "4".repeat(64),
            privateContent: "not projected",
          },
          "accept_app_spec",
        ) ?? "null",
      ),
    ).toEqual({
      appId: "billing-console",
      artifactRevision: "2".repeat(64),
      eligibilityDigest: "3".repeat(64),
      format: "autograph-local-approval-subject-v1",
      outcome: "accept-appspec",
      phase: "appspec",
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      subjectDigest: "1".repeat(64),
      workspaceDigest: "4".repeat(64),
    });
    expect(
      JSON.parse(
        publicApprovalDescription(
          {
            changeSet: {
              changes: [{ path: "private" }],
              digest: "5".repeat(64),
            },
          },
          "accept_change_set",
        ) ?? "null",
      ),
    ).toEqual({
      format: "autograph-local-approval-subject-v1",
      outcome: "accept_change_set",
      phase: "change_set",
      subjectDigest: "5".repeat(64),
    });
  });

  it("denies missing and wrong-phase GitHub receipts before approval", () => {
    expect(
      approvalRequestDecision({
        githubSource,
        phase: "appspec",
        subjectDigest: receipt.subjectDigest,
        toolInput: {
          appId: "billing-console",
          expectedArtifactDigest: receipt.subjectDigest,
          expectedArtifactRevision: "2".repeat(64),
          expectedEligibilityDigest: "3".repeat(64),
          expectedSourceSha: receipt.baseSha,
          expectedSourceTree: "c".repeat(40),
          expectedWorkspaceDigest: "4".repeat(64),
        },
        toolName: "accept_app_spec",
      }),
    ).toMatchObject({ type: "denied" });
    expect(
      approvalRequestDecision({
        githubSource,
        phase: "change_set",
        subjectDigest: receipt.subjectDigest,
        toolInput: { approvalReceipt: receipt },
        toolName: "accept_change_set",
      }),
    ).toMatchObject({ type: "denied" });
  });

  it("requires a closed local subject before requesting approval", () => {
    expect(
      approvalRequestDecision({
        githubSource: undefined,
        phase: "appspec",
        subjectDigest: "1".repeat(64),
        toolInput: {
          appId: "billing-console",
          expectedArtifactDigest: "1".repeat(64),
          expectedArtifactRevision: "2".repeat(64),
          expectedEligibilityDigest: "3".repeat(64),
          expectedSourceSha: "a".repeat(40),
          expectedSourceTree: "b".repeat(40),
          expectedWorkspaceDigest: "4".repeat(64),
        },
        toolName: "accept_app_spec",
      }),
    ).toBe("user-approval");
  });
});
