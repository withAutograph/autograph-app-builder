import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import { HostedOperatorError } from "@/lib/provisioning/hosted-operator-contract";

export default defineTool({
  description:
    "Read the exact session and operation journal. Pending means unfinished; this read executes or approves nothing and does not prove worker liveness. After factual repair, historical failure is not a current refusal: continue through existing preparation, planning and approval rules. Fresh authority, credential, isolation or provider refusals remain binding. Do not infer readiness from a repair report. To recover an already planned data export, use operation export and the exportId previously returned in this session. This owner-scoped read returns the saved canonical plan, exact request and status without replanning, approving or extracting data. Submit that same request plus plan to export-app-hosted-data through its existing separate approval path. To recover an already planned continuity run, use operation continuity and its previously returned intentId. This returns the original saved plan, exact request and status; submit that same request plus plan to run-app-continuity-tests through its existing separate approval path. Do not replan against the latest runtime to recover a saved intent. Do not use a preparation operationRef lookup for an export or continuity run, ask the user for opaque IDs, or reconstruct the private plan from guesses.",
  async execute(input, ctx) {
    try {
      const operator = await hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
      if ("operation" in input) {
        return input.operation === "continuity"
          ? await operator.readContinuity(input.intentId, ctx.abortSignal)
          : await operator.readTenantExport(input.exportId, ctx.abortSignal);
      }
      const { operationRef, ...selection } = input;
      return await operator.request(
        {
          action: "status",
          operationRef,
          selection: {
            ...selection,
            sessionId: operator.sessionId ?? ctx.session.id,
          },
        },
        ctx.abortSignal,
      );
    } catch (error) {
      return {
        ...("intentId" in input ? { intentId: input.intentId } : {}),
        ...("exportId" in input ? { exportId: input.exportId } : {}),
        ...("appId" in input ? { appId: input.appId } : {}),
        authenticatedBehavior: "unassessed" as const,
        code: error instanceof HostedOperatorError ? error.code : "operator_unavailable",
        status: "blocked" as const,
      };
    }
  },
  inputSchema: z.union([
    z.strictObject({ operation: z.literal("continuity"), intentId: z.uuid() }),
    z.strictObject({ operation: z.literal("export"), exportId: z.uuid() }),
    z.strictObject({
      appId: z.string().min(1),
      branch: z.string().min(1),
      environment: z.literal("preview"),
      operationRef: z.uuid(),
      projectId: z.string().min(1),
    }),
  ]),
});
