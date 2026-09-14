import { z } from "zod";
import type { ImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";

export const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const approvalReceiptSchema = z
  .strictObject({
    baseRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u),
    baseSha: gitObjectIdSchema,
    format: z.literal("autograph-eve-approval-receipt-v2"),
    outcome: z.enum(["accept-appspec", "accept_change_set", "create-draft-pr"]),
    phase: z.enum(["appspec", "change_set", "publication"]),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    repositoryId: z.string().regex(/^\d+$/u),
    subjectDigest: digest,
  })
  .superRefine((receipt, context) => {
    let expectedOutcome = "create-draft-pr";
    if (receipt.phase === "appspec") {expectedOutcome = "accept-appspec";}
    else if (receipt.phase === "change_set") {expectedOutcome = "accept_change_set";}
    if (receipt.outcome !== expectedOutcome)
      {context.addIssue({
        code: "custom",
        message: "Approval outcome does not match its phase.",
        path: ["outcome"],
      });}
  });

export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;
export type ApprovalTarget = Pick<
  ApprovalReceipt,
  "repositoryId" | "repository" | "baseRef" | "baseSha"
>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseApprovalReceipt(value: unknown): ApprovalReceipt {
  return approvalReceiptSchema.parse(value);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function approvalTarget(receipt: ApprovalReceipt): ApprovalTarget {
  return {
    baseRef: receipt.baseRef,
    baseSha: receipt.baseSha,
    repository: receipt.repository,
    repositoryId: receipt.repositoryId,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function approvalTargetFromGitHubSource(
  source: ImmutableGitHubSourceReceipt,
): ApprovalTarget {
  return {
    baseRef: source.resolvedRef,
    baseSha: source.resolvedSha,
    repository: `${source.repository.owner}/${source.repository.name}`,
    repositoryId: source.repository.repositoryId,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertApprovalReceipt(input: {
  actual: ApprovalReceipt;
  phase: ApprovalReceipt["phase"];
  target: ApprovalTarget;
  subjectDigest: string;
}): ApprovalReceipt {
  const actual = parseApprovalReceipt(input.actual);
  let expectedOutcome = "create-draft-pr";
  if (input.phase === "appspec") {expectedOutcome = "accept-appspec";}
  else if (input.phase === "change_set") {expectedOutcome = "accept_change_set";}
  if (
    actual.phase !== input.phase ||
    actual.outcome !== expectedOutcome ||
    actual.repositoryId !== input.target.repositoryId ||
    actual.repository !== input.target.repository ||
    actual.baseRef !== input.target.baseRef ||
    actual.baseSha !== input.target.baseSha ||
    actual.subjectDigest !== input.subjectDigest
  )
    {throw new Error("The approval receipt does not match the exact subject.");}
  return actual;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function publicApprovalDescription(input: unknown, toolName?: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {return undefined;}
  const record = input as Record<string, unknown>;
  if (Object.hasOwn(record, "approvalReceipt")) {
    const parsed = approvalReceiptSchema.safeParse(record.approvalReceipt);
    let expectedPhase: ApprovalReceipt["phase"] | undefined;
    if (toolName === "accept_app_spec") {expectedPhase = "appspec";}
    else if (toolName === "accept_change_set") {expectedPhase = "change_set";}
    else if (toolName === "publish-github-draft-pr") {expectedPhase = "publication";}
    return parsed.success && (expectedPhase === undefined || parsed.data.phase === expectedPhase)
      ? JSON.stringify(parsed.data)
      : undefined;
  }
  if (toolName === "accept_app_spec") {
    const parsed = z
      .strictObject({
        appId,
        artifactRevision: digest,
        eligibilityDigest: digest,
        format: z.literal("autograph-local-approval-subject-v1"),
        outcome: z.literal("accept-appspec"),
        phase: z.literal("appspec"),
        sourceSha: gitObjectIdSchema,
        sourceTree: gitObjectIdSchema,
        subjectDigest: digest,
        workspaceDigest: digest,
      })
      .safeParse({
        appId: record.appId,
        artifactRevision: record.expectedArtifactRevision,
        eligibilityDigest: record.expectedEligibilityDigest,
        format: "autograph-local-approval-subject-v1",
        outcome: "accept-appspec",
        phase: "appspec",
        sourceSha: record.expectedSourceSha,
        sourceTree: record.expectedSourceTree,
        subjectDigest: record.expectedArtifactDigest,
        workspaceDigest: record.expectedWorkspaceDigest,
      });
    return parsed.success ? JSON.stringify(parsed.data) : undefined;
  }
  if (toolName === "accept_change_set") {
    const changeSet =
      typeof record.changeSet === "object" &&
      record.changeSet !== null &&
      !Array.isArray(record.changeSet)
        ? (record.changeSet as Record<string, unknown>)
        : undefined;
    const parsed = z
      .strictObject({
        format: z.literal("autograph-local-approval-subject-v1"),
        outcome: z.literal("accept_change_set"),
        phase: z.literal("change_set"),
        subjectDigest: digest,
      })
      .safeParse({
        format: "autograph-local-approval-subject-v1",
        outcome: "accept_change_set",
        phase: "change_set",
        subjectDigest: changeSet?.digest,
      });
    return parsed.success ? JSON.stringify(parsed.data) : undefined;
  }
  return undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function approvalRequestDecision(input: {
  phase: "appspec" | "change_set";
  toolName: "accept_app_spec" | "accept_change_set";
  toolInput: Record<string, unknown>;
  githubSource: ImmutableGitHubSourceReceipt | undefined;
  subjectDigest: string;
}): "user-approval" | { type: "denied"; reason: string } {
  const receipt = input.toolInput.approvalReceipt;
  if (input.githubSource === undefined) {
    if (
      Object.hasOwn(input.toolInput, "approvalReceipt") ||
      publicApprovalDescription(input.toolInput, input.toolName) === undefined
    )
      {return {
        reason: "The local approval subject is missing or invalid.",
        type: "denied",
      };}
    return "user-approval";
  }
  try {
    assertApprovalReceipt({
      actual: approvalReceiptSchema.parse(receipt),
      phase: input.phase,
      subjectDigest: input.subjectDigest,
      target: approvalTargetFromGitHubSource(input.githubSource),
    });
    return "user-approval";
  } catch {
    return {
      reason: "The GitHub-bound approval receipt is missing, stale, or for the wrong phase.",
      type: "denied",
    };
  }
}
