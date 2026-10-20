import { sleep } from "workflow";
import { defineWorkflowTool } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { TenantExportApprovalInput } from "../../lib/eve/private-export-approval";
import { tenantExportApprovalInputSchema } from "../../lib/eve/private-export-approval";
import {
  exportHostedTenantDataStep,
  readHostedTenantExportApprovalStep,
} from "../../lib/agent/export-app-hosted-data-step";

// eslint-disable-next-line eslint/func-style -- Workflow approval is a top-level Node step.
async function exportApproval(
  ctx: ApprovalContext<TenantExportApprovalInput>,
): Promise<ApprovalStatus> {
  "use step";
  if (ctx.toolInput === undefined) {
    return "user-approval";
  }
  try {
    const retained = await readHostedTenantExportApprovalStep(ctx.toolInput, ctx);
    return retained.approved ? "not-applicable" : "user-approval";
  } catch {
    return {
      type: "denied",
      reason:
        "The current owner and exact saved export intent could not be verified. Retry the same export when access is restored.",
    };
  }
}

export default defineWorkflowTool({
  description:
    "Export one explicitly requested customer's app data after approval of the exact server-resolved plan from plan-app-hosted-runtime operation export. All public tenant tables are exported read-only as private NDJSON and a manifest, retained for the current owner on Builder. This does not grant access, prepare resources, change app data, or deploy. Resume the same intent after uncertainty; status reads never restart an export.",
  inputSchema: tenantExportApprovalInputSchema,
  approval: exportApproval,
  async execute(input, ctx) {
    "use workflow";
    let delayMs = 1000;
    let approval = await readHostedTenantExportApprovalStep(input, ctx, delayMs);
    while (!approval.approved) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Durable sleep releases compute while the human settlement commits.
      await sleep(new Date(approval.checkAfter));
      delayMs = Math.min(delayMs * 2, 30_000);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Re-read the same exact receipt after durable backoff.
      approval = await readHostedTenantExportApprovalStep(input, ctx, delayMs);
    }
    return await exportHostedTenantDataStep(input, ctx);
  },
});
