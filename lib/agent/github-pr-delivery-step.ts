import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { WorkflowStepToolContext } from "eve/tools";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import type { RepositoryProductionSchemaActivation } from "../provisioning/repository-production-delivery";

// eslint-disable-next-line eslint/func-style -- Workflow requires a top-level step declaration.
export async function continueGitHubPrDelivery(
  approval: GitHubPrDeliveryApproval,
  ctx: WorkflowStepToolContext,
  readyAt?: string,
) {
  "use step";
  const { continueGitHubPrDeliveryWithPorts } = await import("./github-pr-delivery-execution");
  return await continueGitHubPrDeliveryWithPorts(approval, ctx, readyAt);
}

// eslint-disable-next-line eslint/func-style -- Workflow approval runs in the Node step runtime.
export async function approveGitHubPrDelivery(
  ctx: ApprovalContext<GitHubPrDeliveryApproval>,
): Promise<ApprovalStatus> {
  "use step";
  // oxlint-disable-next-line react-doctor/async-parallel -- Preserve module initialization and failure order before approval.
  const { appBuilderWorkflowState } = await import("./workflow-state");
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Keep publication and approval operations in their established order.
  const { draftReconciliationState } = await import("./draft-reconciliation-state");
  const { resolveGitHubPrDeliverySubject } = await import("./github-pr-delivery-subject");
  // Eve binds this approval to the invoking session and this exact tool call.
  const subject = resolveGitHubPrDeliverySubject(
    appBuilderWorkflowState.get(),
    draftReconciliationState.get(),
  );
  const inputSession = ctx.toolInput?.sessionId ?? ctx.session.id;
  if (
    ctx.toolInput === undefined ||
    inputSession !== ctx.session.id ||
    subject === undefined ||
    subject.proposalDigest !== ctx.toolInput.proposalDigest
  ) {
    return {
      reason: "The approved revision must belong to this session's current reviewed publication.",
      type: "denied",
    };
  }
  const input = ctx.toolInput;
  const { reconciliationDigest, installationId } = input;
  const { currentDirectProductionGrant } = await import("./direct-production-state");
  const directGrant =
    installationId === undefined || installationId !== subject.installationId
      ? undefined
      : currentDirectProductionGrant(ctx, {
          appId: subject.appId,
          repositoryId: input.repositoryId,
          repositoryFullName: `${input.owner}/${input.name}`,
          baseBranch: input.baseBranch,
          installationId,
        });
  if (reconciliationDigest !== undefined || directGrant !== undefined) {
    const { reconciliation } = subject;
    const selectedInstallationId = subject.installationId;
    if (
      reconciliationDigest !== undefined &&
      (reconciliation?.digest !== reconciliationDigest || selectedInstallationId !== installationId)
    ) {
      return { reason: "The reviewed draft update has changed.", type: "denied" };
    }
    const { githubPublicationRuntimeForSession } =
      await import("./deployment-github-publication-runtime");
    const runtime = await githubPublicationRuntimeForSession(
      ctx.session.auth,
      selectedInstallationId === undefined ? undefined : { selectedInstallationId },
    );
    let reconciledHead: string | undefined;
    if (reconciliationDigest !== undefined && reconciliation !== undefined) {
      reconciledHead =
        (await runtime.inspectPublishedReconciliationHead?.(
          input.proposalDigest,
          reconciliation,
        )) ?? undefined;
      if (reconciledHead !== input.headSha) {
        return { reason: "The reviewed draft revision could not be verified.", type: "denied" };
      }
    }
    if (directGrant !== undefined) {
      const observed = await runtime.inspectPublishedPullRequest?.(
        input.proposalDigest,
        reconciledHead,
      );
      const target = observed?.reviewedTarget;
      const matchesReviewedRevision = [
        observed?.state === "open",
        observed?.reviewedRevision === true,
        target?.repositoryId === input.repositoryId,
        target?.owner === input.owner,
        target?.name === input.name,
        target?.baseBranch === input.baseBranch,
        target?.pullRequestNumber === input.pullRequestNumber,
        target?.headSha === input.headSha,
        input.readyAt === undefined || observed?.readyAt === input.readyAt,
      ].every(Boolean);
      if (!matchesReviewedRevision) {
        return { reason: "The reviewed draft revision could not be verified.", type: "denied" };
      }
    }
  }
  ctx.abortSignal.throwIfAborted();
  const { captureGitHubPrDeliveryAuthority } = await import("./github-pr-delivery-authority");
  if (directGrant === undefined) {
    await captureGitHubPrDeliveryAuthority(input, ctx);
    return "user-approval";
  }
  await captureGitHubPrDeliveryAuthority(input, ctx, {
    directProductionGrantDigest: directGrant.digest,
  });
  return "approved";
}

/** After an exact native activation, install only the schema that the combined approval covered. */
// eslint-disable-next-line eslint/func-style -- Workflow requires a top-level step declaration.
export async function continueGitHubProductionSchema(
  input: GitHubPrDeliveryApproval,
  ctx: WorkflowStepToolContext,
  activation: RepositoryProductionSchemaActivation,
) {
  "use step";
  const { readGitHubPrDeliveryAuthority } = await import("./github-pr-delivery-authority");
  const authority = await readGitHubPrDeliveryAuthority(input, ctx);
  if (
    !("productionSchemaApprovalCallId" in authority) ||
    activation.reviewedHeadSha !== input.headSha
  ) {
    throw new Error("The approved Production schema revision changed.");
  }
  const { observeMergedAppProduction } = await import("./app-production-observation");
  const target = {
    appId: authority.subject.appId,
    repositoryId: input.repositoryId,
    repositoryFullName: `${input.owner}/${input.name}`,
  };
  const observed = await observeMergedAppProduction(target, ctx, activation.mergeSha, true);
  if (observed.status === "monitoring-stopped") {
    return observed;
  }
  if (observed.deployment.requestedRevisionActive !== true) {
    // A previous operator may report the URL live without the exact provider proof needed for setup.
    return observed.requestedRevision === "live"
      ? { ...observed, requestedRevision: "awaiting-activation" as const }
      : observed;
  }
  const { repositoryProductionClientForContext } = await import("./repository-production-client");
  const client = await repositoryProductionClientForContext(ctx);
  const { approvalReference } = await client.plan(target.appId);
  const { setup } = await client.prepare(
    approvalReference,
    authority.productionSchemaApprovalCallId,
    activation,
  );
  if (setup.state !== "ready") {
    return {
      ...observed,
      status: "pending" as const,
      requestedRevision: "awaiting-activation" as const,
    };
  }
  return await observeMergedAppProduction(target, ctx, activation.mergeSha);
}
