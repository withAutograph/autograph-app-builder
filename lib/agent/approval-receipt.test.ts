import { describe, expect, it } from "vitest";

import type { ImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";

import {
  approvalReceiptSchema,
  approvalRequestDecision,
  approvalTarget,
  assertApprovalReceipt,
  publicApprovalDescription,
} from "./approval-receipt";

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
      })
    ).toEqual(receipt);
  });

  it("accepts SHA-256 repository object ids", () => {
    expect(
      approvalReceiptSchema.parse({ ...receipt, baseSha: "a".repeat(64) })
        .baseSha
    ).toHaveLength(64);
  });

  it("rejects extra keys, mismatched outcomes, targets, and subjects", () => {
    expect(() =>
      approvalReceiptSchema.parse({ ...receipt, content: "private" })
    ).toThrow();
    expect(() =>
      approvalReceiptSchema.parse({
        ...receipt,
        outcome: "accept-change-set",
      })
    ).toThrow();
    expect(() =>
      assertApprovalReceipt({
        actual: receipt,
        phase: "appspec",
        subjectDigest: receipt.subjectDigest,
        target: { ...approvalTarget(receipt), repositoryId: "9999" },
      })
    ).toThrow("does not match");
    expect(() =>
      assertApprovalReceipt({
        actual: receipt,
        phase: "appspec",
        subjectDigest: "c".repeat(64),
        target: approvalTarget(receipt),
      })
    ).toThrow("does not match");
  });

  it("projects only the canonical receipt field", () => {
    expect(
      publicApprovalDescription({
        appSpec: "private",
        approvalReceipt: receipt,
        path: "/private/workspace",
      })
    ).toBe(JSON.stringify(receipt));
    expect(
      publicApprovalDescription({
        approvalReceipt: { ...receipt, token: "secret" },
      })
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
          "accept_app_spec"
        ) ?? "null"
      )
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
          "accept_change_set"
        ) ?? "null"
      )
    ).toEqual({
      format: "autograph-local-approval-subject-v1",
      outcome: "accept-change-set",
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
      })
    ).toMatchObject({ type: "denied" });
    expect(
      approvalRequestDecision({
        githubSource,
        phase: "change_set",
        subjectDigest: receipt.subjectDigest,
        toolInput: { approvalReceipt: receipt },
        toolName: "accept_change_set",
      })
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
      })
    ).toBe("user-approval");
  });
});
