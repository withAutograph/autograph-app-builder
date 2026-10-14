import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import { HostedOperatorError } from "@/lib/provisioning/hosted-operator-contract";

export default defineTool({
  description:
    "Read the exact session and operation journal. Pending means unfinished; this read executes or approves nothing and does not prove worker liveness. After factual repair, historical failure is not a current refusal: continue through existing preparation, planning and approval rules. Fresh authority, credential, isolation or provider refusals remain binding. Do not infer readiness from a repair report.",
  async execute(input, ctx) {
    try {
      const { operationRef, ...selection } = input;
      const operator = await hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
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
        appId: input.appId,
        authenticatedBehavior: "unassessed" as const,
        code: error instanceof HostedOperatorError ? error.code : "operator_unavailable",
        status: "blocked" as const,
      };
    }
  },
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    branch: z.string().min(1),
    environment: z.literal("preview"),
    operationRef: z.uuid(),
    projectId: z.string().min(1),
  }),
});
