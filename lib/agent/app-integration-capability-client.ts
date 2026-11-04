import {
  appIntegrationCapabilityPrerequisiteResponseSchema,
  AppIntegrationCapabilityPrerequisiteError,
} from "../provisioning/app-integration-capability-prerequisite";
import type { z } from "zod";
import type { WorkflowStepToolContext } from "eve/tools";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import type { AppIntegrationCapabilityApprovalInput } from "../provisioning/app-integration-capability-contract";
import {
  appIntegrationCapabilityTransportRequestSchema,
  appIntegrationCapabilityPlanResultSchema,
  appIntegrationCapabilityResultSchema,
} from "../provisioning/app-integration-capability-transport";

export const appIntegrationCapabilityClientForContext = async (ctx: WorkflowStepToolContext) => {
  const endpointValue = process.env.HOSTED_RUNTIME_OPERATOR_URL;
  if (endpointValue === undefined || endpointValue === "") {
    throw new Error("protected_operator_required");
  }
  const endpoint = new URL(endpointValue);
  if (
    ![
      endpoint.protocol === "https:",
      endpoint.username === "",
      endpoint.password === "",
      endpoint.pathname === "/",
      endpoint.search === "",
      endpoint.hash === "",
    ].every(Boolean)
  ) {
    throw new Error("protected_operator_required");
  }
  const execution = hostedOperatorCallbackExecution(ctx.session);
  const { authority, principal } = exactForwardedSessionAuthority(ctx.session.auth, {
    realmContinuation: { adapterSessionId: execution.ownerAnchorRunId ?? ctx.session.id },
  });
  const ownerContext = await resolveHostedOperatorOwnerContext({
    adapterSessionId: ctx.session.id,
    authority,
    principal,
    sessionAuth: ctx.session.auth,
    environment: process.env,
    execution,
  });
  const common = { ownerContext, adapterSessionId: ctx.session.id, callId: ctx.callId, execution };
  const token = createVercelWorkloadIdentity().token;
  const send = async <T>(
    input: z.infer<typeof appIntegrationCapabilityTransportRequestSchema>,
    schema: z.ZodType<T>,
  ) => {
    ctx.abortSignal.throwIfAborted();
    const workload = await token();
    const response = await fetch(new URL("/v1/app-integrations", endpoint), {
      method: "POST",
      redirect: "error",
      signal: ctx.abortSignal,
      headers: {
        authorization: `Bearer ${workload}`,
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": workload,
      },
      body: JSON.stringify(appIntegrationCapabilityTransportRequestSchema.parse(input)),
    });
    ctx.abortSignal.throwIfAborted();
    if (response.status === 409) {
      const prerequisite = appIntegrationCapabilityPrerequisiteResponseSchema.parse(
        await response.json(),
      );
      throw new AppIntegrationCapabilityPrerequisiteError(prerequisite.code);
    }
    if (!response.ok) {
      throw new Error("public_release_unavailable");
    }
    return schema.parse(await response.json());
  };
  return {
    sessionId: ownerContext.sessionId,
    plan: async (appId: string) =>
      await send(
        { ...common, action: "app-integration-capability-plan", appId },
        appIntegrationCapabilityPlanResultSchema,
      ),
    prepare: async (input: AppIntegrationCapabilityApprovalInput) =>
      await send(
        { ...common, action: "app-integration-capability-prepare", input },
        appIntegrationCapabilityResultSchema,
      ),
  };
};
