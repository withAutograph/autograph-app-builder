import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import { HostedOperatorError } from "@/lib/provisioning/hosted-operator-contract";

export default defineTool({
  description:
    "Read the protected operator's concrete Preview resource/access plan before asking for effect approval. Returns named targets, roles, effects, cost ownership, retention and an opaque operation reference. Does not allocate hosted resources or execute repository code. Missing protected operator or explicit owner-authorized synthetic Neon context remains blocked.",
  async execute(input, ctx) {
    try {
      const { operation, ...selection } = input;
      const operator = await hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
      return await operator.request(
        {
          action: "plan",
          operation,
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
    operation: z.enum(["prepare", "cleanup"]),
    projectId: z.string().min(1),
  }),
});
