import type { appIntegrationCapabilityPointerSchema } from "../provisioning/app-integration-release-contract";
import {
  publicReleasePrerequisiteResponseSchema,
  PublicReleasePrerequisiteError,
} from "../provisioning/public-release-prerequisite";
import type { z } from "zod";
import type { WorkflowStepToolContext } from "eve/tools";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import type { PublicReleaseApprovalInput } from "../provisioning/public-release-contract";
import {
  publicReleaseTransportRequestSchema,
  publicReleasePlanResultSchema,
  publicReleaseResultSchema,
} from "../provisioning/public-release-transport";

export const publicReleaseClientForContext = async (ctx: WorkflowStepToolContext) => {
  const endpointValue = process.env.HOSTED_RUNTIME_OPERATOR_URL;
  if (endpointValue === undefined || endpointValue === "") {
    throw new Error("protected_operator_required");
  }
  // react-doctor-disable-next-line react-doctor/no-unguarded-throwing-parse-call -- Invalid operator configuration must fail before any protected request.
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
  const { token } = createVercelWorkloadIdentity();
  const send = async <T>(
    input: z.infer<typeof publicReleaseTransportRequestSchema>,
    schema: z.ZodType<T>,
  ) => {
    ctx.abortSignal.throwIfAborted();
    const workload = await token();
    const response = await fetch(new URL("/v1/public-release", endpoint), {
      method: "POST",
      redirect: "error",
      signal: ctx.abortSignal,
      headers: {
        authorization: `Bearer ${workload}`,
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": workload,
      },
      body: JSON.stringify(publicReleaseTransportRequestSchema.parse(input)),
    });
    ctx.abortSignal.throwIfAborted();
    if (response.status === 409) {
      const prerequisite = publicReleasePrerequisiteResponseSchema.parse(await response.json());
      throw new PublicReleasePrerequisiteError(
        prerequisite.code,
        prerequisite.recordedBuilderDestination,
      );
    }
    if (!response.ok) {
      throw new Error("public_release_unavailable");
    }
    return schema.parse(await response.json());
  };
  return {
    sessionId: ownerContext.sessionId,
    plan: async (
      appId: string,
      integrationCapability?: z.infer<typeof appIntegrationCapabilityPointerSchema>,
    ) => {
      const request: Extract<
        z.infer<typeof publicReleaseTransportRequestSchema>,
        { action: "public-release-plan" }
      > = { ...common, action: "public-release-plan", appId };
      if (integrationCapability !== undefined) {
        request.integrationCapability = integrationCapability;
      }
      return await send(request, publicReleasePlanResultSchema);
    },
    release: async (input: PublicReleaseApprovalInput) =>
      await send({ ...common, action: "public-release-run", input }, publicReleaseResultSchema),
    observe: async (input: PublicReleaseApprovalInput) =>
      await send({ ...common, action: "public-release-observe", input }, publicReleaseResultSchema),
  };
};
