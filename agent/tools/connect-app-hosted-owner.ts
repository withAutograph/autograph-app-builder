import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  authorizeHostedNeonForTool,
  hostedNeonBlockedResult,
} from "@/lib/agent/hosted-neon-authorization";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import { HostedOperatorError } from "@/lib/provisioning/hosted-operator-contract";

export default defineTool({
  description:
    "Connect this saved Builder session's normally authenticated owner to the approved protected Preview Neon connector. Uses the ordinary public authorization request and resumes this same session. No app Git ref, database branch, new key or resource preparation is required; only the human can complete provider consent.",
  async execute(_input, ctx) {
    let operator;
    try {
      operator = await hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
    } catch (error) {
      return hostedNeonBlockedResult(
        error instanceof HostedOperatorError ? error.code : "operator_unavailable",
      );
    }
    const code = await authorizeHostedNeonForTool(ctx, operator);
    return code === null ? { status: "owner-connected" } : hostedNeonBlockedResult(code);
  },
  inputSchema: z.strictObject({}),
});
