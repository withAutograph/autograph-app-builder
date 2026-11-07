import { defineTool } from "eve/tools";
import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import { HostedOperatorError } from "@/lib/provisioning/hosted-operator-contract";

interface HostedRuntimeIdentifiers {
  intentId?: string;
  exportId?: string;
  appId?: string;
}

export default defineTool({
  description:
    "Read the exact session and operation journal. Pending means unfinished; this read executes or approves nothing and does not prove worker liveness. After factual repair, historical failure is not a current refusal: continue through existing preparation, planning and approval rules. Fresh authority, credential, isolation or provider refusals remain binding. Do not infer readiness from a repair report. To recover an already planned data export, use operation export and the exportId previously returned in this session. This owner-scoped read returns the saved canonical plan, exact request and status without replanning, approving or extracting data. Submit that same request plus plan to export-app-hosted-data through its existing separate approval path. To recover an already planned continuity run, use operation continuity and its previously returned intentId. This returns the original saved plan, exact request and status. For current approved account/actor/session membership readback without credentials or historical request attribution use operation continuity-verified-actors. For recorded journal checkpoints without replay use operation continuity-checkpoints; unrecorded markers do not prove effects absent. For an owner-scoped locking read of the saved plan's approved tenant bindings, use operation continuity-bindings with that same intentId. Results identify only approved scopes, not the actual browser request or its fence; a read failure is not evidence of an absent binding. Review that canonical scope, then submit only its unchanged request object (action, planRef, planDigest, idempotencyKey) to run-app-continuity-tests through its existing separate approval path. Builder reloads the full saved plan itself; do not reconstruct or copy its nested fields. Do not replan against the latest runtime to recover a saved intent. Do not use a preparation operationRef lookup for an export or continuity run, ask the user for opaque IDs, or reconstruct the private plan from guesses.",
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Project closed read diagnostics without changing error authority.
  async execute(input, ctx) {
    try {
      const operator = await hostedOperatorClientForSession(
        ctx.session.auth,
        ctx.session.id,
        process.env,
        hostedOperatorCallbackExecution(ctx.session),
      );
      if ("operation" in input) {
        if (input.operation === "continuity-verified-actors") {
          return await operator.readContinuityVerifiedActors(input.intentId, ctx.abortSignal);
        }
        if (input.operation === "continuity-checkpoints") {
          return await operator.readContinuityCheckpoints(input.intentId, ctx.abortSignal);
        }
        if (input.operation === "continuity-bindings") {
          return await operator.readContinuityBindings(input.intentId, ctx.abortSignal);
        }
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
      const identifiers: HostedRuntimeIdentifiers = {};
      if ("intentId" in input) identifiers.intentId = input.intentId;
      if ("exportId" in input) identifiers.exportId = input.exportId;
      if ("appId" in input) identifiers.appId = input.appId;
      return {
        ...identifiers,
        ...("intentId" in input &&
        error instanceof HostedOperatorError &&
        error.recoveryStage !== undefined
          ? { recoveryStage: error.recoveryStage }
          : {}),
        ...("intentId" in input &&
        error instanceof HostedOperatorError &&
        error.recoveryProgressAdvanced !== undefined
          ? { recoveryProgressAdvanced: error.recoveryProgressAdvanced }
          : {}),
        ...("intentId" in input &&
        error instanceof HostedOperatorError &&
        error.continuityReadStage !== undefined
          ? { continuityReadStage: error.continuityReadStage }
          : {}),
        authenticatedBehavior: "unassessed" as const,
        code: error instanceof HostedOperatorError ? error.code : "operator_unavailable",
        status: "blocked" as const,
      };
    }
  },
  inputSchema: z.union([
    z.strictObject({ operation: z.literal("continuity"), intentId: z.uuid() }),
    z.strictObject({ operation: z.literal("continuity-bindings"), intentId: z.uuid() }),
    z.strictObject({ operation: z.literal("continuity-checkpoints"), intentId: z.uuid() }),
    z.strictObject({ operation: z.literal("continuity-verified-actors"), intentId: z.uuid() }),
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
