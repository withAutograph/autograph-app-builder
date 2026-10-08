// eslint-disable eslint/no-use-before-define -- Workflow entrypoints and steps intentionally use module-level declarations.
import type { PreparedRuntimeSelection } from "@/lib/agent/prepared-runtime-selection";
import type { WorkflowStepToolContext, ToolInputRequest } from "eve/tools";
import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "@/lib/provisioning/hosted-operator-contract";
import { preparedRuntimeSelections } from "@/lib/agent/prepared-runtime-selection";

export const hostedRuntimeApprovalInputSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  branch: z.string().min(1),
  environment: z.literal("preview"),
  operationRef: z.uuid(),
  plan: hostedOperatorPlanSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  projectId: z.string().min(1),
});
export default defineWorkflowTool({
  approval: always(),
  description:
    "After approval of the concrete protected operator plan, prepare exactly its named Preview resources/access. Pass the plan and operation reference returned by plan-app-hosted-runtime. The protected service independently verifies the durable approval and current owner authority, resumes the same journal and reports actual effects. No installer credential or repository script is sent to an app Sandbox. This does not deploy or activate Production.",
  async execute(input, ctx) {
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

/** The execution response resolves only after the operator releases its lease. */
// eslint-disable-next-line eslint/func-style, eslint/no-use-before-define -- Workflow SDK requires a hoisted top-level step declaration.
export async function prepareHostedRuntimeStep(
  input: z.infer<typeof hostedRuntimeApprovalInputSchema>,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  try {
    const operator = await hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
    return await prepareHostedRuntimeWithOperator(input, ctx, operator, (selection) => {
      preparedRuntimeSelections.update((selections) => ({
        ...selections,
        [input.appId]: selection,
      }));
    });
  } catch (error) {
    return blockedPreparation(input.appId, error);
  }
}

export const prepareHostedRuntimeWithOperator = async (
  input: z.infer<typeof hostedRuntimeApprovalInputSchema>,
  ctx: Pick<WorkflowStepToolContext, "abortSignal" | "callId"> & { session: { id: string } },
  operator: Awaited<ReturnType<typeof hostedOperatorClientForSession>>,
  retain: (selection: PreparedRuntimeSelection) => void,
) => {
  try {
    const selection = {
      appId: input.appId,
      branch: input.branch,
      environment: input.environment,
      projectId: input.projectId,
      sessionId: operator.sessionId ?? ctx.session.id,
    };
    if (
      input.plan.action !== "prepare" ||
      operatorPlanDigest(input.plan) !== input.planDigest ||
      !sameOperatorSelection(input.plan.selection, selection)
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
    if (
      result.operationRef !== undefined &&
      (result.status === "prepared" ||
        result.status === "pending" ||
        result.status === "auth-schema-prepared")
    ) {
      retain({
        appId: input.appId,
        branch: input.branch,
        operationRef: result.operationRef,
        planDigest: input.planDigest,
        projectId: input.projectId,
        sessionId: operator.sessionId ?? ctx.session.id,
      });
    }
    const identityInput =
      result.status === "auth-schema-prepared"
        ? await operator.authIdentityInput(
            {
              action: "auth-identity-input",
              operationRef: input.operationRef,
              selection,
            },
            ctx.abortSignal,
          )
        : null;
    return { identityInput, result };
  } catch (error) {
    return blockedPreparation(input.appId, error);
  }
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Catch boundary converts arbitrary provider errors to a closed public code.
const blockedPreparation = (appId: string, error: unknown) => ({
  identityInput: null,
  result: {
    appId,
    authenticatedBehavior: "unassessed" as const,
    code: error instanceof HostedOperatorError ? error.code : "operator_unavailable",
    status: "blocked" as const,
  },
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
