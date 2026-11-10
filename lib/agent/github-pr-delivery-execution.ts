import { readGitHubPrDeliveryAuthority } from "./github-pr-delivery-authority";
import type { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import {
  readGitHubProductionDeliveryReadiness,
  githubProductionSetupContinuation,
} from "./github-production-delivery-readiness";
import { isDeepStrictEqual } from "node:util";
import type { WorkflowStepToolContext } from "eve/tools";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";

import type { GitHubPrDeliveryObservation } from "../repository/github-pr-delivery";
import type { GitHubPrEffectReceipt } from "../repository/github-pr-effect-journal";

const WAITING_FOR_CHECKS = "waiting-for-checks";
const READY_CYCLE_CHANGED = "ready-cycle-changed";

const startReadyCycle = async (input: {
  approvedReadyAt: string | undefined;
  observed: GitHubPrDeliveryObservation;
  runReady: (reconcileOnly: boolean) => Promise<GitHubPrEffectReceipt | undefined>;
}) => {
  const { approvedReadyAt, observed } = input;
  if (approvedReadyAt !== undefined) {
    return !observed.draft && observed.readyAt === approvedReadyAt
      ? { status: WAITING_FOR_CHECKS satisfies typeof WAITING_FOR_CHECKS, readyAt: approvedReadyAt }
      : { status: READY_CYCLE_CHANGED satisfies typeof READY_CYCLE_CHANGED };
  }
  const result = await input.runReady(!observed.draft);
  if (result === undefined) {
    return { status: READY_CYCLE_CHANGED satisfies typeof READY_CYCLE_CHANGED };
  }
  if (result.status === "failed") {
    return { status: "ready-rejected" as const, reason: result.code };
  }
  if (result.status !== "succeeded" || result.evidence.kind !== "pr-ready") {
    return { status: "ready-unconfirmed" as const };
  }
  return {
    status: WAITING_FOR_CHECKS satisfies typeof WAITING_FOR_CHECKS,
    readyAt: result.evidence.readyAt,
  };
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

type GitHubDeliveryRuntime = Pick<
  Awaited<ReturnType<typeof githubPublicationRuntimeForSession>>,
  "inspectPublishedPullRequest" | "runPublishedPullRequestEffect"
>;
export interface GitHubPrDeliveryStepPorts {
  runtime?: () => Promise<GitHubDeliveryRuntime>;
  readAuthority?: typeof readGitHubPrDeliveryAuthority;
  readProduction?: typeof readGitHubProductionDeliveryReadiness;
}
/** The parent/current-owner projection, not ambient workflow child state, supplies app authority. */
export const continueGitHubPrDeliveryWithPorts = async (
  approval: GitHubPrDeliveryApproval,
  ctx: WorkflowStepToolContext,
  readyAt?: string,
  ports: GitHubPrDeliveryStepPorts = {},
) => {
  const readAuthority = ports.readAuthority ?? readGitHubPrDeliveryAuthority;
  const authority = await readAuthority(approval, ctx);
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Verify canonical ownership before opening the scoped provider runtime.
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
  const selection =
    installationId === undefined ? undefined : { selectedInstallationId: installationId };
  const runtime =
    ports.runtime === undefined
      ? await githubPublicationRuntimeForSession(ctx.session.auth, selection)
      : await ports.runtime();
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
        await readAuthority(approval, ctx);
        const readyEffect: Parameters<typeof run>[0] = { ...activeEffect, kind: "pr-ready" };
        if (reconcileOnly) {
          readyEffect.reconcileOnly = reconcileOnly;
        }
        return await run(readyEffect);
      },
    });
  }
  if (observed.draft || observed.readyAt !== readyAt) {
    return { status: READY_CYCLE_CHANGED satisfies typeof READY_CYCLE_CHANGED };
  }
  if (observed.checks === "failed") {
    return { status: "checks-failed" as const };
  }
  if (observed.checks !== "passed") {
    return { status: WAITING_FOR_CHECKS satisfies typeof WAITING_FOR_CHECKS, readyAt };
  }

  const productionSetup = await (ports.readProduction ?? readGitHubProductionDeliveryReadiness)(
    {
      appId: authority.subject.appId,
      repositoryId: reviewedTarget.repositoryId,
      repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
    },
    ctx,
    {
      requirements: authority.requirements,
      retain: () => {
        /* The durable parent projection retains service enrollment. */
      },
    },
  );
  if (
    productionSetup.applicable &&
    (productionSetup.state !== "ready" || productionSetup.preparationRequired)
  ) {
    return {
      status: "production-setup-required" as const,
      readyAt,
      productionSetup,
      nextCall: githubProductionSetupContinuation(productionSetup),
    };
  }

  ctx.abortSignal.throwIfAborted();
  await readAuthority(approval, ctx);
  const result = await run({ ...activeEffect, kind: "pr-merge", readyAt });
  return mergeResult(result);
};
