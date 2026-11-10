import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { WorkflowStepToolContext } from "eve/tools";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";

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
  const { reconciliationDigest } = ctx.toolInput;
  if (reconciliationDigest !== undefined) {
    const { reconciliation, installationId } = subject;
    if (
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
  ctx.abortSignal.throwIfAborted();
  const { captureGitHubPrDeliveryAuthority } = await import("./github-pr-delivery-authority");
  await captureGitHubPrDeliveryAuthority(ctx.toolInput, ctx);
  return "user-approval";
}
