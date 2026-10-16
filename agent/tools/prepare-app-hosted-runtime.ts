import type {
  reportRuntimePreparationFailure,
  reportRuntimePreparationStarted,
} from "../../lib/provisioning/hosted-operator-consent-diagnostic";
import type { ToolInputRequest, WorkflowStepToolContext, WorkflowToolContext } from "eve/tools";
import { defineWorkflowTool } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { createHook, sleep } from "workflow";

import {
  waitForHostedRuntimeApprovalReceipt,
  readHostedRuntimeApprovalReceiptStep,
} from "../../lib/agent/hosted-runtime-approval-wait";
import { prepareHostedRuntimeStep } from "../../lib/agent/prepare-app-hosted-runtime-step";
import type { readHostedRuntimePriorApproval } from "../../lib/agent/hosted-runtime-prior-approval";
import type { HostedRuntimeApprovalEnvelope } from "../../lib/agent/prepare-app-hosted-runtime-step";
import {
  acknowledgeHostedRuntimeIdentityWaitStep,
  continueHostedRuntimeOwnerPreparation,
  registerHostedRuntimeIdentityWaitStep,
} from "../../lib/agent/hosted-runtime-identity-wait";
import type {
  HostedRuntimeOperationReference,
  HostedRuntimePreparationRequest,
  HostedRuntimeResumeSnapshot,
} from "../../lib/agent/hosted-runtime-approved-reference";
import type { HostedRuntimeIdentityWake } from "../../lib/agent/hosted-runtime-identity-wait";

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

export const hostedRuntimePreparationRequestSchema = z.union([
  hostedRuntimeApprovalInputSchema,
  z.strictObject({
    appId: hostedRuntimeApprovalInputSchema.shape.appId,
    operationRef: hostedRuntimeApprovalInputSchema.shape.operationRef,
  }),
]);

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
  if (prepared.identityInput !== null && !participantPlan) {
    return {
      ...prepared.result,
      authIdentityLink: prepared.identityInput.browserUrl,
      authIdentityLinkExpiresAt: prepared.identityInput.expiresAt,
      nextStep:
        "Complete the protected Auth identity link, then retry this same approved preparation to read back the server-side result.",
    };
  }
  while (prepared.identityInput !== null) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each ordinary human reply determines whether the same operation may resume.
    const identityResponse = await ctx.ask(
      participantIdentityInputQuestion(prepared.identityInput),
    );
    if (identityResponse.status !== "answered") {
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Injected reporter alone parses caught exceptions into closed diagnostic metadata.
  diagnostic?: { onStarted?: () => void; onFailure?: (error: unknown) => void },
): Promise<ApprovalStatus> => {
  if (ctx.toolInput === undefined) {
    return "user-approval";
  }
  try {
    diagnostic?.onStarted?.();
  } catch {
    /* Diagnostics cannot change approval evaluation. */
  }
  try {
    const retained = await readPrior(ctx.toolInput, ctx);
    return retained === null ? "user-approval" : "not-applicable";
  } catch (error) {
    try {
      diagnostic?.onFailure?.(error);
    } catch {
      /* Preserve the original denial. */
    }
    return {
      type: "denied",
      reason:
        "The current owner and saved approval could not be verified. Retry the same preparation when access is restored.",
    };
  }
};

// oxlint-disable-next-line eslint/func-style -- The Workflow SDK requires a top-level async function for the step boundary.
export async function hostedRuntimePreparationApproval(
  ctx: ApprovalContext<HostedRuntimePreparationRequest>,
): Promise<ApprovalStatus> {
  "use step";
  let diagnostic:
    | {
        reportRuntimePreparationFailure: typeof reportRuntimePreparationFailure;
        reportRuntimePreparationStarted: typeof reportRuntimePreparationStarted;
      }
    | undefined;
  try {
    diagnostic = await import("../../lib/provisioning/hosted-operator-consent-diagnostic");
    diagnostic.reportRuntimePreparationStarted(ctx.session.id, "approval_module_loading");
    const { toolInput } = ctx;
    if (toolInput !== undefined && !("plan" in toolInput)) {
      const reference = await import("../../lib/agent/hosted-runtime-approved-reference");
      await reference.loadHostedRuntimeApprovedReference(toolInput, ctx);
      return "not-applicable";
    }
    const prior = await import("../../lib/agent/hosted-runtime-prior-approval");
    return await evaluateHostedRuntimePreparationApproval(
      { ...ctx, toolInput },
      prior.readHostedRuntimePriorApproval,
      {
        onStarted: () =>
          diagnostic?.reportRuntimePreparationStarted(ctx.session.id, "approval_evaluation"),
        onFailure: (error) =>
          diagnostic?.reportRuntimePreparationFailure(ctx.session.id, "approval_evaluation", error),
      },
    );
  } catch (error) {
    diagnostic?.reportRuntimePreparationFailure(ctx.session.id, "approval_module_loading", error);
    return {
      type: "denied",
      reason: "Saved preparation authority is unavailable. Retry when access is restored.",
    };
  }
}

// oxlint-disable-next-line eslint/func-style -- Workflow steps must be top-level async declarations.
async function loadHostedRuntimeReferenceStep(
  input: HostedRuntimeOperationReference,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const reference = await import("../../lib/agent/hosted-runtime-approved-reference");
  return await reference.loadHostedRuntimeApprovedReference(input, ctx);
}

// oxlint-disable-next-line eslint/func-style -- Workflow steps must be top-level async declarations.
async function assertHostedRuntimeReferenceStep(
  snapshot: HostedRuntimeResumeSnapshot,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const reference = await import("../../lib/agent/hosted-runtime-approved-reference");
  await reference.assertHostedRuntimeApprovedReference(snapshot, ctx);
}

export default defineWorkflowTool({
  approval: hostedRuntimePreparationApproval,
  description:
    "After approval of the concrete protected operator plan, prepare exactly its named Preview resources/access. Pass the plan and operation reference returned by plan-app-hosted-runtime. To resume a previously human-approved operation after context loss, pass only appId and operationRef; the server loads its exact retained full input and approval. Technical retries of the identical operation reuse its server-owned durable human approval. Changed plans require fresh approval. A gateway_delivery_failed result means an actual native Gateway build failed: follow its nextAction to request a new plan in this session, then obtain ordinary approval for the returned changed plan. Repeating an old plan does not adopt repaired Gateway source. Unknown alias or hostname assignment outcomes still require reconciliation. The protected service independently verifies the original approval and current owner authority, resumes the same journal and reports actual effects. No installer credential or repository script is sent to an app Sandbox. This does not deploy or activate Production.",
  async *execute(input: HostedRuntimePreparationRequest, ctx) {
    "use workflow";
    let approved: HostedRuntimeApprovalEnvelope;
    let prepare: typeof prepareHostedRuntimeStep = prepareHostedRuntimeStep;
    let register = registerHostedRuntimeIdentityWaitStep;
    let acknowledge = acknowledgeHostedRuntimeIdentityWaitStep;
    if ("plan" in input) {
      approved = input;
    } else {
      const loaded = await loadHostedRuntimeReferenceStep(input, ctx);
      approved = loaded.input;
      const { snapshot } = loaded;
      prepare = async (original, context) => {
        await assertHostedRuntimeReferenceStep(snapshot, context);
        const result = await prepareHostedRuntimeStep(original, context, {
          recoverOriginalPlan: false,
        });
        await assertHostedRuntimeReferenceStep(snapshot, context);
        return result;
      };
      register = async (original, context, registration) => {
        await assertHostedRuntimeReferenceStep(snapshot, context);
        const result = await registerHostedRuntimeIdentityWaitStep(original, context, registration);
        await assertHostedRuntimeReferenceStep(snapshot, context);
        return result;
      };
      acknowledge = async (original, context, event) => {
        await assertHostedRuntimeReferenceStep(snapshot, context);
        const result = await acknowledgeHostedRuntimeIdentityWaitStep(original, context, event);
        await assertHostedRuntimeReferenceStep(snapshot, context);
        return result;
      };
    }
    await waitForHostedRuntimeApprovalReceipt(approved, ctx, {
      read: readHostedRuntimeApprovalReceiptStep,
      sleepUntil: async (deadline) => {
        await sleep(deadline);
      },
    });
    return yield* continueHostedRuntimeOwnerPreparation(approved, ctx, prepare, {
      createHook: () => createHook<HostedRuntimeIdentityWake>(),
      register,
      acknowledge,
      sleepUntil: async (expiresAt) => {
        await sleep(expiresAt);
      },
    });
  },
  inputSchema: hostedRuntimePreparationRequestSchema,
});
