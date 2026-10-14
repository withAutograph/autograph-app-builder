import {
  reportRuntimePreparationFailure,
  reportRuntimePreparationStarted,
} from "../../lib/provisioning/hosted-operator-consent-diagnostic";
import type { ToolInputRequest, WorkflowToolContext } from "eve/tools";
import { defineWorkflowTool } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";

import { prepareHostedRuntimeStep } from "../../lib/agent/prepare-app-hosted-runtime-step";
import type { readHostedRuntimePriorApproval } from "../../lib/agent/hosted-runtime-prior-approval";
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

export const participantIdentityInputQuestion = (identityInput: {
  browserUrl: string;
  expiresAt: string;
}): ToolInputRequest => ({
  allowFreeform: true,
  dismissible: true,
  display: "confirmation",
  options: [{ id: "continue", label: "I signed in" }],
  prompt: `Sign in to the account you approved using [Connect your account](${identityInput.browserUrl}), then continue here. This link expires at ${identityInput.expiresAt}. We will resume the same approved account preparation.`,
});

/** Uses the same approval invocation across ordinary human input and protected step readback. */
export const continueHostedRuntimePreparation = async (
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowToolContext,
  prepare: typeof prepareHostedRuntimeStep,
) => {
  let prepared = await prepare(input, ctx);
  const participantPlan =
    input.plan.stage === "auth-participants" && input.plan.normalActorProgram !== undefined;
  while (prepared.identityInput !== null) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each ordinary human reply determines whether the same operation may resume.
    const identityResponse = await ctx.ask(
      participantPlan
        ? participantIdentityInputQuestion(prepared.identityInput)
        : realmIdentityInputQuestion(prepared.identityInput),
    );
    if (!participantPlan || identityResponse.status !== "answered") {
      return { ...prepared.result, identityResponse: identityResponse.status };
    }
    // Re-read real capture under the same approved invocation; answering alone establishes no identity.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck real capture after the preceding human reply.
    prepared = await prepare(input, ctx);
    if (prepared.identityInput === null) {
      return { ...prepared.result, identityResponse: identityResponse.status };
    }
  }
  return prepared.result;
};

/** A technical retry reuses server-owned human authority for the exact unchanged operation. */
export const evaluateHostedRuntimePreparationApproval = async (
  ctx: ApprovalContext<HostedRuntimeApprovalEnvelope>,
  readPrior: typeof readHostedRuntimePriorApproval,
): Promise<ApprovalStatus> => {
  if (ctx.toolInput === undefined) {
    return "user-approval";
  }
  reportRuntimePreparationStarted(ctx.session.id, "approval_evaluation");
  try {
    const retained = await readPrior(ctx.toolInput, ctx);
    return retained === null ? "user-approval" : "not-applicable";
  } catch (error) {
    reportRuntimePreparationFailure(ctx.session.id, "approval_evaluation", error);
    return {
      type: "denied",
      reason:
        "The current owner and saved approval could not be verified. Retry the same preparation when access is restored.",
    };
  }
};

// oxlint-disable-next-line eslint/func-style -- The Workflow SDK requires a top-level async function for the step boundary.
export async function hostedRuntimePreparationApproval(
  ctx: ApprovalContext<HostedRuntimeApprovalEnvelope>,
): Promise<ApprovalStatus> {
  "use step";
  reportRuntimePreparationStarted(ctx.session.id, "approval_module_loading");
  try {
    const prior = await import("../../lib/agent/hosted-runtime-prior-approval");
    return await evaluateHostedRuntimePreparationApproval(
      ctx,
      prior.readHostedRuntimePriorApproval,
    );
  } catch (error) {
    reportRuntimePreparationFailure(ctx.session.id, "approval_module_loading", error);
    return {
      type: "denied",
      reason: "Saved preparation authority is unavailable. Retry when access is restored.",
    };
  }
}

export default defineWorkflowTool({
  approval: hostedRuntimePreparationApproval,
  description:
    "After approval of the concrete protected operator plan, prepare exactly its named Preview resources/access. Pass the plan and operation reference returned by plan-app-hosted-runtime. Technical retries of the identical operation reuse its server-owned durable human approval. Changed plans require fresh approval. The protected service independently verifies the original approval and current owner authority, resumes the same journal and reports actual effects. No installer credential or repository script is sent to an app Sandbox. This does not deploy or activate Production.",
  async execute(input: HostedRuntimeApprovalEnvelope, ctx) {
    "use workflow";
    return await continueHostedRuntimePreparation(input, ctx, prepareHostedRuntimeStep);
  },
  inputSchema: hostedRuntimeApprovalInputSchema,
});
