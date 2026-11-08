import { isDeepStrictEqual } from "node:util";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { WorkflowStepToolContext } from "eve/tools";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";

import type { GitHubPrDeliveryObservation } from "../repository/github-pr-delivery";
import type { GitHubPrEffectReceipt } from "../repository/github-pr-effect-journal";

const startReadyCycle = async (input: {
  approvedReadyAt: string | undefined;
  observed: GitHubPrDeliveryObservation;
  runReady: (reconcileOnly: boolean) => Promise<GitHubPrEffectReceipt | undefined>;
}) => {
  const { approvedReadyAt, observed } = input;
  if (approvedReadyAt !== undefined) {
    return !observed.draft && observed.readyAt === approvedReadyAt
      ? { status: "waiting-for-checks" as const, readyAt: approvedReadyAt }
      : { status: "ready-cycle-changed" as const };
  }
  const result = await input.runReady(!observed.draft);
  if (result === undefined) {
    return { status: "ready-cycle-changed" as const };
  }
  if (result.status === "failed") {
    return { status: "ready-rejected" as const, reason: result.code };
  }
  if (result.status !== "succeeded" || result.evidence.kind !== "pr-ready") {
    return { status: "ready-unconfirmed" as const };
  }
  return { status: "waiting-for-checks" as const, readyAt: result.evidence.readyAt };
};

const mergeResult = (result: GitHubPrEffectReceipt | undefined) => {
  if (result?.status === "failed") {
    return { status: "merge-rejected" as const, reason: result.code };
  }
  if (result?.status !== "succeeded" || result.evidence.kind !== "pr-merge") {
    return { status: "merge-unconfirmed" as const };
  }
  return { status: "merged" as const, mergeCommitSha: result.evidence.mergeCommitSha };
};

// eslint-disable-next-line eslint/func-style -- Workflow requires a top-level step declaration.
export async function continueGitHubPrDelivery(
  approval: GitHubPrDeliveryApproval,
  ctx: WorkflowStepToolContext,
  readyAt?: string,
) {
  "use step";
  const { githubPublicationRuntimeForSession } =
    await import("./deployment-github-publication-runtime");
  const {
    installationId,
    proposalDigest,
    reconciliationDigest,
    readyAt: approvedReadyAt,
    ...reviewedTarget
  } = approval;
  delete reviewedTarget.sessionId;
  ctx.abortSignal.throwIfAborted();
  const runtime = await githubPublicationRuntimeForSession(
    ctx.session.auth,
    installationId === undefined ? undefined : { selectedInstallationId: installationId },
  );
  const inspect = runtime.inspectPublishedPullRequest;
  const run = runtime.runPublishedPullRequestEffect;
  if (inspect === undefined || run === undefined) {
    throw new Error("GitHub pull request delivery is unavailable.");
  }
  // The approval callback independently verifies this reconciled head before Eve
  // dispatches the approved input to this workflow.
  const observed = await inspect(
    proposalDigest,
    ...(reconciliationDigest === undefined ? [] : [reviewedTarget.headSha]),
  );
  if (!observed.reviewedRevision || !isDeepStrictEqual(observed.reviewedTarget, reviewedTarget)) {
    return { status: "revision-changed" as const };
  }
  const approvedByCallId = ctx.callId;
  const effect: Pick<
    Parameters<typeof run>[0],
    "approvedByCallId" | "proposalDigest" | "reviewedTarget" | "reconciledHeadSha"
  > = {
    approvedByCallId,
    proposalDigest,
    reviewedTarget,
  };
  if (reconciliationDigest !== undefined) {
    effect.reconciledHeadSha = reviewedTarget.headSha;
  }
  const activeEffect = { ...effect, abortSignal: ctx.abortSignal };
  if (observed.state === "merged" && observed.mergeCommitSha !== undefined) {
    if (readyAt !== undefined && observed.readyAt === readyAt) {
      await run({ ...effect, kind: "pr-merge", readyAt, reconcileOnly: true });
    }
    return { status: "merged" as const, mergeCommitSha: observed.mergeCommitSha };
  }
  if (observed.state !== "open") {
    return { status: "closed" as const };
  }

  if (readyAt === undefined) {
    return await startReadyCycle({
      approvedReadyAt,
      observed,
      runReady: async (reconcileOnly) => {
        ctx.abortSignal.throwIfAborted();
        return await run({
          ...activeEffect,
          kind: "pr-ready",
          ...(reconcileOnly ? { reconcileOnly } : {}),
        });
      },
    });
  }
  if (observed.draft || observed.readyAt !== readyAt) {
    return { status: "ready-cycle-changed" as const };
  }
  if (observed.checks === "failed") {
    return { status: "checks-failed" as const };
  }
  if (observed.checks !== "passed") {
    return { status: "waiting-for-checks" as const, readyAt };
  }

  ctx.abortSignal.throwIfAborted();
  const result = await run({ ...activeEffect, kind: "pr-merge", readyAt });
  return mergeResult(result);
}

// eslint-disable-next-line eslint/func-style -- Workflow approval runs in the Node step runtime.
export async function approveGitHubPrDelivery(
  ctx: ApprovalContext<GitHubPrDeliveryApproval>,
): Promise<ApprovalStatus> {
  "use step";
  const { appBuilderWorkflowState } = await import("./workflow-state");
  // Eve binds this approval to the invoking session and this exact tool call.
  const state = appBuilderWorkflowState.get();
  const inputSession = ctx.toolInput?.sessionId ?? ctx.session.id;
  if (
    ctx.toolInput === undefined ||
    inputSession !== ctx.session.id ||
    state.phase !== "reviewed" ||
    state.githubDraftProposal?.proposal.digest !== ctx.toolInput.proposalDigest
  ) {
    return {
      reason: "The approved revision must belong to this session's current reviewed publication.",
      type: "denied",
    };
  }
  const { reconciliationDigest } = ctx.toolInput;
  if (reconciliationDigest !== undefined) {
    const { draftReconciliationState } = await import("./draft-reconciliation-state");
    const candidate = draftReconciliationState.get();
    const reconciliation = candidate?.publishedReconciliation;
    const installationId = state.githubDestinationReview?.installation.installationId;
    if (
      candidate?.appId !== state.appSpec.appId ||
      reconciliation?.digest !== reconciliationDigest ||
      installationId !== ctx.toolInput.installationId
    ) {
      return { reason: "The reviewed draft update has changed.", type: "denied" };
    }
    const { githubPublicationRuntimeForSession } =
      await import("./deployment-github-publication-runtime");
    const runtime = await githubPublicationRuntimeForSession(
      ctx.session.auth,
      installationId === undefined ? undefined : { selectedInstallationId: installationId },
    );
    const verified = await runtime.inspectPublishedReconciliationHead?.(
      ctx.toolInput.proposalDigest,
      reconciliation,
    );
    if (verified !== ctx.toolInput.headSha) {
      return { reason: "The reviewed draft revision could not be verified.", type: "denied" };
    }
  }
  return "user-approval";
}
