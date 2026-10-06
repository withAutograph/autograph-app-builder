import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import { HostedOperatorError } from "@/lib/provisioning/hosted-operator-contract";

export default defineTool({
  description:
    "Read the protected operator journal status for this session and exact operation reference. Does not execute or approve effects.",
  async execute(input, ctx) {
    try {
      const { operationRef, ...selection } = input;
      return await hostedOperatorClientForSession(ctx.session.auth).request(
        { action: "status", operationRef, selection: { ...selection, sessionId: ctx.session.id } },
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
