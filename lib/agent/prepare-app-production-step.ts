import type { WorkflowStepToolContext } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { DirectProductionGrant } from "./direct-production-authorization";
import type { RepositoryProductionPrepareInput } from "../provisioning/repository-production-approval";

export const nextProductionDeliveryCall = { tool: "read_github_pr_delivery", input: {} } as const;

interface ProductionIdentityWait {
  appId: string;
  grantDigest: string;
  operationRef: string;
  expiresAt: string;
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level approval step.
export async function approvePrepareAppProduction(
  ctx: ApprovalContext<RepositoryProductionPrepareInput>,
): Promise<ApprovalStatus> {
  "use step";
  const { toolInput } = ctx;
  if (toolInput === undefined || !("version" in toolInput)) {
    return "user-approval";
  }
  const { currentDirectProductionGrant } = await import("./direct-production-state");
  const grant = currentDirectProductionGrant(ctx, { appId: toolInput.appId });
  if (grant === undefined) {
    return "user-approval";
  }
  if (grant.subject.revision?.schemaChange !== undefined) {
    return {
      type: "denied",
      reason: "Builder applies the approved field after the reviewed deployment activates.",
    };
  }
  if (grant.subject.revision !== undefined) {
    return {
      type: "denied",
      reason:
        "This revision uses the app’s existing Production data and access. Continue to the reviewed release.",
    };
  }
  const { matchesDirectProductionSetupReference } =
    await import("../provisioning/repository-production-approval");
  return matchesDirectProductionSetupReference(grant.subject, toolInput)
    ? "approved"
    : { type: "denied", reason: "The app’s Production setup differs from its approved release." };
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareAppProductionStep(
  input: RepositoryProductionPrepareInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const [
    { repositoryProductionClientForContext },
    { readCanonicalGitHubPrDeliveryOwner },
    { matchesDirectProductionSetupReference },
  ] = await Promise.all([
    import("./repository-production-client"),
    import("./github-pr-delivery-authority"),
    import("../provisioning/repository-production-approval"),
  ]);
  const client = await repositoryProductionClientForContext(ctx);
  if ("version" in input) {
    let grant: DirectProductionGrant | undefined;
    try {
      const canonical = await readCanonicalGitHubPrDeliveryOwner(ctx);
      grant = canonical.decision.directProduction;
    } catch {
      // An ordinary setup can still prove its own settled approval in the operator.
    }
    ctx.abortSignal.throwIfAborted();
    if (
      grant !== undefined &&
      grant.subject.sessionId === ctx.session.id &&
      matchesDirectProductionSetupReference(grant.subject, input)
    ) {
      const result = await client.prepare(input, grant.callId);
      if (result.setup.state === "ready") {
        return { result: { ...result, nextCall: nextProductionDeliveryCall } };
      }
      const expiresAt = result.setup.expiresAt ?? result.creator.expiresAt;
      if (
        result.setup.state === "identity-required" &&
        result.setup.signInUrl !== undefined &&
        expiresAt !== undefined &&
        Number.isFinite(Date.parse(expiresAt))
      ) {
        const identityWait: ProductionIdentityWait = {
          appId: input.appId,
          grantDigest: grant.digest,
          operationRef: result.setup.operationRef,
          expiresAt,
        };
        return { result, identityWait };
      }
      return { result };
    }
  }
  return { result: await client.prepare(input) };
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function readProductionIdentitySetupStep(
  input: ProductionIdentityWait,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const [{ readCanonicalGitHubPrDeliveryOwner }, { repositoryProductionClientForContext }] =
    await Promise.all([
      import("./github-pr-delivery-authority"),
      import("./repository-production-client"),
    ]);
  const { decision } = await readCanonicalGitHubPrDeliveryOwner(ctx);
  const { directProduction: grant } = decision;
  const current = [
    decision.decision !== "blocked",
    decision.workflowPhase === "reviewed",
    grant?.digest === input.grantDigest,
    grant?.subject.appId === input.appId,
    grant?.subject.sessionId === ctx.session.id,
  ].every(Boolean);
  if (!current) {
    throw new Error("The approved Production release changed while waiting for app sign-in.");
  }
  const client = await repositoryProductionClientForContext(ctx);
  const setup = await client.status(input.appId);
  if (setup.operationRef !== input.operationRef) {
    throw new Error("The approved Production setup changed while waiting for app sign-in.");
  }
  return setup;
}
