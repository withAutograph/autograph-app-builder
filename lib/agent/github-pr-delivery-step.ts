import { isDeepStrictEqual } from "node:util";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { WorkflowStepToolContext } from "eve/tools";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";

import type { GitHubPrDeliveryObservation } from "../repository/github-pr-delivery";
import type { GitHubPrEffectReceipt } from "../repository/github-pr-effect-journal";

const WAITING_FOR_CHECKS_STATUS = "waiting-for-checks" as const;
const READY_CYCLE_CHANGED_STATUS = "ready-cycle-changed" as const;

const startReadyCycle = async (input: {
  approvedReadyAt: string | undefined;
  observed: GitHubPrDeliveryObservation;
  runReady: (reconcileOnly: boolean) => Promise<GitHubPrEffectReceipt | undefined>;
}) => {
  const { approvedReadyAt, observed } = input;
  if (approvedReadyAt !== undefined) {
    return !observed.draft && observed.readyAt === approvedReadyAt
      ? { readyAt: approvedReadyAt, status: WAITING_FOR_CHECKS_STATUS }
      : { status: READY_CYCLE_CHANGED_STATUS };
  }
  const result = await input.runReady(!observed.draft);
  if (result === undefined) {
    return { status: READY_CYCLE_CHANGED_STATUS };
  }
  if (result.status === "failed") {
    return { reason: result.code, status: "ready-rejected" as const };
  }
  if (result.status !== "succeeded" || result.evidence.kind !== "pr-ready") {
    return { status: "ready-unconfirmed" as const };
  }
  return { readyAt: result.evidence.readyAt, status: WAITING_FOR_CHECKS_STATUS };
};

const mergeResult = (result: GitHubPrEffectReceipt | undefined) => {
  if (result?.status === "failed") {
    return { reason: result.code, status: "merge-rejected" as const };
  }
  if (result?.status !== "succeeded" || result.evidence.kind !== "pr-merge") {
    return { status: "merge-unconfirmed" as const };
  }
  return { mergeCommitSha: result.evidence.mergeCommitSha, status: "merged" as const };
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
    readyAt: approvedReadyAt,
    sessionId,
    ...reviewedTarget
  } = approval;
  if (ctx.session.id !== sessionId) {
    throw new Error("The merge approval belongs to a different Builder session.");
  }
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
  const observed = await inspect(proposalDigest);
  if (!observed.reviewedRevision || !isDeepStrictEqual(observed.reviewedTarget, reviewedTarget)) {
    return { status: "revision-changed" as const };
  }
  const approvedByCallId = ctx.callId;
  const effect = { approvedByCallId, proposalDigest, reviewedTarget };
  const activeEffect = { ...effect, abortSignal: ctx.abortSignal };
  if (observed.state === "merged" && observed.mergeCommitSha !== undefined) {
    if (readyAt !== undefined && observed.readyAt === readyAt) {
      await run({ ...effect, kind: "pr-merge", readyAt, reconcileOnly: true });
    }
    return { mergeCommitSha: observed.mergeCommitSha, status: "merged" as const };
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
        const readyEffect: Parameters<typeof run>[0] = {
          ...activeEffect,
          kind: "pr-ready",
        };
        if (reconcileOnly) readyEffect.reconcileOnly = reconcileOnly;
        return await run(readyEffect);
      },
    });
  }
  if (observed.draft || observed.readyAt !== readyAt) {
    return { status: READY_CYCLE_CHANGED_STATUS };
  }
  if (observed.checks === "failed") {
    return { status: "checks-failed" as const };
  }
  if (observed.checks !== "passed") {
    return { readyAt, status: WAITING_FOR_CHECKS_STATUS };
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
  const state = appBuilderWorkflowState.get();
  if (
    ctx.toolInput === undefined ||
    ctx.toolInput.sessionId !== ctx.session.id ||
    state.phase !== "reviewed" ||
    state.githubDraftProposal?.proposal.digest !== ctx.toolInput.proposalDigest
  ) {
    return {
      reason: "The approved revision must belong to this session's current reviewed publication.",
      type: "denied",
    };
  }
  return "user-approval";
}
