import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "@/lib/provisioning/hosted-operator-contract";

export const hostedRuntimeApprovalInputSchema = z
  .strictObject({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    branch: z.string().min(1),
    environment: z.literal("preview"),
    operationRef: z.uuid(),
    // Advertise a compact JSON plan; native input validation retains the full contract before approval.
    plan: z.record(z.string(), z.json()),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    projectId: z.string().min(1),
  })
  .superRefine((input, context) => {
    const parsed = hostedOperatorPlanSchema.safeParse(input.plan);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ ...issue, path: ["plan", ...issue.path] });
      }
    }
  });
export default defineTool({
  approval: always(),
  description:
    "After approval of the concrete protected operator plan, cleanup exactly its named Preview resources/access. Pass the plan and operation reference returned by plan-app-hosted-runtime. The protected service independently verifies the durable approval and current owner authority, resumes the same journal and reports actual effects. No installer credential or repository script is sent to an app Sandbox. This does not deploy or activate Production.",
  async execute(input, ctx) {
    try {
      const plan = hostedOperatorPlanSchema.parse(input.plan);
      const operator = await hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
      const selection = {
        appId: input.appId,
        branch: input.branch,
        environment: input.environment,
        projectId: input.projectId,
        sessionId: operator.sessionId ?? ctx.session.id,
      };
      if (
        plan.action !== "cleanup" ||
        operatorPlanDigest(plan) !== input.planDigest ||
        !sameOperatorSelection(plan.selection, selection)
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const result = await operator.request(
        {
          action: "execute",
          callId: ctx.callId,
          operationRef: input.operationRef,
          planDigest: input.planDigest,
          selection: {
            appId: input.appId,
            branch: input.branch,
            environment: input.environment,
            projectId: input.projectId,
            sessionId: operator.sessionId ?? ctx.session.id,
          },
        },
        ctx.abortSignal,
      );
      return result;
    } catch (error) {
      return {
        appId: input.appId,
        authenticatedBehavior: "unassessed" as const,
        code: error instanceof HostedOperatorError ? error.code : "operator_unavailable",
        status: "blocked" as const,
      };
    }
  },
  inputSchema: hostedRuntimeApprovalInputSchema,
});
