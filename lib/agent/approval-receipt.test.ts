import { describe, expect, it } from "vitest";

import {
  approvalReceiptSchema,
  approvalRequestDecision,
  approvalTarget,
  assertApprovalReceipt,
  publicApprovalDescription,
} from "./approval-receipt";
import type { ImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";

const receipt = {
  format: "autograph-eve-approval-receipt-v2" as const,
  phase: "appspec" as const,
  outcome: "accept-appspec" as const,
  repositoryId: "1234",
  repository: "withAutograph/arrusted-development",
  baseRef: "refs/heads/main",
  baseSha: "a".repeat(40),
  subjectDigest: "b".repeat(64),
};

describe("approval receipt", () => {
  const githubSource = {
    digest: "f".repeat(64),
    resolvedRef: receipt.baseRef,
    resolvedSha: receipt.baseSha,
    repository: {
      repositoryId: receipt.repositoryId,
      owner: "withAutograph",
      name: "arrusted-development",
    },
  } as ImmutableGitHubSourceReceipt;
  it("accepts one closed canonical receipt and its exact target", () => {
    expect(approvalReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(approvalTarget(receipt)).toEqual({
      repositoryId: receipt.repositoryId,
      repository: receipt.repository,
      baseRef: receipt.baseRef,
      baseSha: receipt.baseSha,
    });
    expect(
      assertApprovalReceipt({
        actual: receipt,
        phase: "appspec",
        target: approvalTarget(receipt),
        subjectDigest: receipt.subjectDigest,
      }),
    ).toEqual(receipt);
  });

  it("accepts SHA-256 repository object ids", () => {
    expect(
      approvalReceiptSchema.parse({ ...receipt, baseSha: "a".repeat(64) })
        .baseSha,
    ).toHaveLength(64);
  });

  it("rejects extra keys, mismatched outcomes, targets, and subjects", () => {
    expect(() =>
      approvalReceiptSchema.parse({ ...receipt, content: "private" }),
    ).toThrow();
    expect(() =>
      approvalReceiptSchema.parse({
        ...receipt,
        outcome: "accept-change-set",
      }),
    ).toThrow();
    expect(() =>
      assertApprovalReceipt({
        actual: receipt,
        phase: "appspec",
        target: { ...approvalTarget(receipt), repositoryId: "9999" },
        subjectDigest: receipt.subjectDigest,
      }),
    ).toThrow("does not match");
    expect(() =>
      assertApprovalReceipt({
        actual: receipt,
        phase: "appspec",
        target: approvalTarget(receipt),
        subjectDigest: "c".repeat(64),
      }),
    ).toThrow("does not match");
  });

  it("projects only the canonical receipt field", () => {
    expect(
      publicApprovalDescription({
        approvalReceipt: receipt,
        appSpec: "private",
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
            expectedSourceSha: "a".repeat(40),
            expectedSourceTree: "b".repeat(40),
            expectedEligibilityDigest: "3".repeat(64),
            expectedWorkspaceDigest: "4".repeat(64),
            privateContent: "not projected",
          },
          "accept_app_spec",
        ) ?? "null",
      ),
    ).toEqual({
      format: "autograph-local-approval-subject-v1",
      phase: "appspec",
      outcome: "accept-appspec",
      appId: "billing-console",
      subjectDigest: "1".repeat(64),
      artifactRevision: "2".repeat(64),
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      eligibilityDigest: "3".repeat(64),
      workspaceDigest: "4".repeat(64),
    });
    expect(
      JSON.parse(
        publicApprovalDescription(
          {
            changeSet: {
              digest: "5".repeat(64),
              changes: [{ path: "private" }],
            },
          },
          "accept_change_set",
        ) ?? "null",
      ),
    ).toEqual({
      format: "autograph-local-approval-subject-v1",
      phase: "change_set",
      outcome: "accept-change-set",
      subjectDigest: "5".repeat(64),
    });
  });

  it("denies missing and wrong-phase GitHub receipts before approval", () => {
    expect(
      approvalRequestDecision({
        phase: "appspec",
        toolName: "accept_app_spec",
        toolInput: {
          appId: "billing-console",
          expectedArtifactDigest: receipt.subjectDigest,
          expectedArtifactRevision: "2".repeat(64),
          expectedSourceSha: receipt.baseSha,
          expectedSourceTree: "c".repeat(40),
          expectedEligibilityDigest: "3".repeat(64),
          expectedWorkspaceDigest: "4".repeat(64),
        },
        githubSource,
        subjectDigest: receipt.subjectDigest,
      }),
    ).toMatchObject({ type: "denied" });
    expect(
      approvalRequestDecision({
        phase: "change_set",
        toolName: "accept_change_set",
        toolInput: { approvalReceipt: receipt },
        githubSource,
        subjectDigest: receipt.subjectDigest,
      }),
    ).toMatchObject({ type: "denied" });
  });

  it("requires a closed local subject before requesting approval", () => {
    expect(
      approvalRequestDecision({
        phase: "appspec",
        toolName: "accept_app_spec",
        toolInput: {
          appId: "billing-console",
          expectedArtifactDigest: "1".repeat(64),
          expectedArtifactRevision: "2".repeat(64),
          expectedSourceSha: "a".repeat(40),
          expectedSourceTree: "b".repeat(40),
          expectedEligibilityDigest: "3".repeat(64),
          expectedWorkspaceDigest: "4".repeat(64),
        },
        githubSource: undefined,
        subjectDigest: "1".repeat(64),
      }),
    ).toBe("user-approval");
  });
});
