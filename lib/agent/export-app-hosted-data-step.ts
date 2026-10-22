import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import type { WorkflowStepToolContext } from "eve/tools";

import type { TenantExportApprovalInput } from "../eve/private-export-approval";

type ExportContext = Pick<WorkflowStepToolContext, "session" | "callId" | "abortSignal">;

// eslint-disable-next-line eslint/func-style -- Workflow requires a top-level step declaration.
export async function exportHostedTenantDataStep(
  input: TenantExportApprovalInput,
  ctx: ExportContext,
) {
  "use step";
  const [{ tenantExportApprovalInputSchema }, { hostedOperatorClientForSession }] =
    await Promise.all([
      import("../eve/private-export-approval"),
      import("../provisioning/hosted-operator-client"),
    ]);
  const parsed = tenantExportApprovalInputSchema.parse(input);
  ctx.abortSignal.throwIfAborted();
  const operator = await hostedOperatorClientForSession(
    ctx.session.auth,
    ctx.session.id,
    process.env,
    hostedOperatorCallbackExecution(ctx.session),
  );
  const { plan, ...request } = parsed;
  if (plan.target.sessionId !== operator.sessionId) {
    throw new Error("Export session differs.");
  }
  return await operator.exportTenantData(request, ctx.callId, ctx.abortSignal);
}

// eslint-disable-next-line eslint/func-style -- Workflow approval runs in the Node step runtime.
export async function readHostedTenantExportApprovalStep(
  input: TenantExportApprovalInput,
  ctx: ExportContext,
  delayMs = 1000,
) {
  "use step";
  const [{ tenantExportApprovalInputSchema }, { hostedOperatorClientForSession }] =
    await Promise.all([
      import("../eve/private-export-approval"),
      import("../provisioning/hosted-operator-client"),
    ]);
  const { plan, ...request } = tenantExportApprovalInputSchema.parse(input);
  const operator = await hostedOperatorClientForSession(
    ctx.session.auth,
    ctx.session.id,
    process.env,
    hostedOperatorCallbackExecution(ctx.session),
  );
  if (plan.target.sessionId !== operator.sessionId) {
    throw new Error("Export session differs.");
  }
  const result = await operator.tenantExportApproval(request, ctx.abortSignal);
  return { ...result, checkAfter: new Date(Date.now() + delayMs).toISOString() };
}
