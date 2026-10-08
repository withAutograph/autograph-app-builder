import type { ToolInputRequest } from "eve/tools";
import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { prepareHostedRuntimeStep } from "../../lib/agent/prepare-app-hosted-runtime-step";
import type { HostedRuntimeApprovalEnvelope } from "../../lib/agent/prepare-app-hosted-runtime-step";

export const hostedRuntimeApprovalInputSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  branch: z.string().min(1),
  environment: z.literal("preview"),
  operationRef: z.uuid(),
  // The protected step parses the full strict plan schema before calculating its digest.
  plan: z.record(z.string(), z.json()),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  projectId: z.string().min(1),
});

export const realmIdentityInputQuestion = (identityInput: {
  browserUrl: string;
  expiresAt: string;
}): ToolInputRequest => ({
  allowFreeform: true,
  dismissible: true,
  display: "confirmation",
  options: [{ id: "continue", label: "I connected my Auth account" }],
  prompt: `The Auth schema is prepared. Sign in or create your account using [Connect your Auth account](${identityInput.browserUrl}), then continue here. This link expires at ${identityInput.expiresAt}. App access and the working Preview still require a fresh approved plan.`,
});

export default defineWorkflowTool({
  approval: always(),
  description:
    "After approval of the concrete protected operator plan, prepare exactly its named Preview resources/access. Pass the plan and operation reference returned by plan-app-hosted-runtime. The protected service independently verifies the durable approval and current owner authority, resumes the same journal and reports actual effects. No installer credential or repository script is sent to an app Sandbox. This does not deploy or activate Production.",
  async execute(input: HostedRuntimeApprovalEnvelope, ctx) {
    "use workflow";
    const { result, identityInput } = await prepareHostedRuntimeStep(input, ctx);
    if (identityInput === null) {
      return result;
    }
    const identityResponse = await ctx.ask(realmIdentityInputQuestion(identityInput));
    return { ...result, identityResponse: identityResponse.status };
  },
  inputSchema: hostedRuntimeApprovalInputSchema,
});
