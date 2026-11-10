import type { WorkflowStepToolContext } from "eve/tools";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import {
  authSchemaRolloutApplyInputSchema,
  authSchemaRolloutApprovalReference,
  authSchemaRolloutPath,
  authSchemaRolloutPlanResponseSchema,
  authSchemaRolloutReviewResponseSchema,
  authSchemaRolloutStatusSchema,
} from "../provisioning/production-auth-schema-rollout-contract";
import type {
  AuthSchemaRolloutApproval,
  AuthSchemaRolloutApplyInput,
} from "../provisioning/production-auth-schema-rollout-contract";

type AuthSchemaRolloutReadAction = "plan" | "status" | "review";
interface AuthSchemaRolloutExecutionSelection {
  operationRef: string;
  planDigest: string;
  approvedByCallId: string;
  approvalDigest?: string;
}

/** Internal platform rollout transport; the service separately verifies enrolled admin authority. */
export const createAuthSchemaRolloutClient = (input: {
  endpoint: string;
  ownerContext: OperatorOwnerContext;
  callId: string;
  signal: AbortSignal;
  workloadToken: () => Promise<string>;
  fetch: typeof fetch;
}) => {
  const endpoint = new URL(input.endpoint);
  const invalidEndpoint = [
    endpoint.protocol !== "https:",
    endpoint.username !== "",
    endpoint.password !== "",
    endpoint.pathname !== "/",
    endpoint.search !== "",
    endpoint.hash !== "",
  ].some(Boolean);
  if (invalidEndpoint) {
    throw new Error("protected_operator_required");
  }
  const { ownerContext } = input;
  const send = async <Result>(
    action: AuthSchemaRolloutReadAction | "execute",
    selection:
      | { profileId: string }
      | {
          operationRef: string;
          planDigest?: string;
          approvalDigest?: string;
          approvedByCallId?: string;
        },
    schema: z.ZodType<Result>,
  ) => {
    input.signal.throwIfAborted();
    const failureMessage =
      action === "execute"
        ? "Builder could not confirm the Auth schema rollout result. Read status for this same operation before retrying; do not create a replacement rollout."
        : "Builder could not read the Production Auth schema rollout. This read did not apply a schema change. Preserve the same rollout and restore platform operator access.";
    try {
      const workload = await input.workloadToken();
      input.signal.throwIfAborted();
      const response = await input.fetch(new URL(authSchemaRolloutPath, endpoint), {
        method: "POST",
        redirect: "error",
        signal: input.signal,
        headers: {
          authorization: `Bearer ${workload}`,
          "content-type": "application/json",
          "x-vercel-trusted-oidc-idp-token": workload,
        },
        body: JSON.stringify({
          version: 1,
          action,
          sessionId: ownerContext.sessionId,
          ownerContext,
          ...selection,
        }),
      });
      input.signal.throwIfAborted();
      if (!response.ok) {
        throw new Error(failureMessage);
      }
      const result = schema.parse(await response.json());
      input.signal.throwIfAborted();
      return result;
    } catch {
      input.signal.throwIfAborted();
      throw new Error(failureMessage);
    }
  };
  const assertScope = (plan: AuthSchemaRolloutApproval) => {
    if (
      plan.scope.sessionId !== ownerContext.sessionId ||
      !isDeepStrictEqual(plan.scope.authority, ownerContext.authority)
    ) {
      throw new Error("auth_schema_rollout_scope_mismatch");
    }
  };
  const assertReview = (result: z.infer<typeof authSchemaRolloutReviewResponseSchema>) => {
    assertScope(result.plan);
    if (
      !isDeepStrictEqual(result.approvalReference, authSchemaRolloutApprovalReference(result.plan))
    ) {
      throw new Error("auth_schema_rollout_scope_mismatch");
    }
  };
  return {
    async plan(profileId: string) {
      const result = await send("plan", { profileId }, authSchemaRolloutPlanResponseSchema);
      assertScope(result.plan);
      if (result.plan.scope.profileId !== profileId) {
        throw new Error("auth_schema_rollout_scope_mismatch");
      }
      return { ...result, approvalReference: authSchemaRolloutApprovalReference(result.plan) };
    },
    async review(operationRef: string) {
      const selected = z.uuid().parse(operationRef);
      const result = await send(
        "review",
        { operationRef: selected },
        authSchemaRolloutReviewResponseSchema,
      );
      assertReview(result);
      if (result.plan.operationRef !== selected) {
        throw new Error("auth_schema_rollout_scope_mismatch");
      }
      return result;
    },
    async apply(value: AuthSchemaRolloutApplyInput) {
      const approved = authSchemaRolloutApplyInputSchema.parse(value);
      if (approved.version === 1) {
        assertScope(approved);
      }
      const selection: AuthSchemaRolloutExecutionSelection = {
        operationRef: approved.operationRef,
        planDigest: approved.planDigest,
        approvedByCallId: input.callId,
      };
      if (approved.version === 2) {
        selection.approvalDigest = approved.approvalDigest;
      }
      const result = await send("execute", selection, authSchemaRolloutStatusSchema);
      if (result.operationRef !== approved.operationRef) {
        throw new Error("auth_schema_rollout_scope_mismatch");
      }
      return result;
    },
    async status(operationRef: string) {
      const selected = z.uuid().parse(operationRef);
      const result = await send(
        "status",
        { operationRef: selected },
        authSchemaRolloutStatusSchema,
      );
      if (result.operationRef !== selected) {
        throw new Error("auth_schema_rollout_scope_mismatch");
      }
      return result;
    },
  };
};

/** Uses the same forwarded owner and workload identity as normal protected setup. */
export const authSchemaRolloutClientForContext = async (ctx: WorkflowStepToolContext) => {
  const endpoint = process.env.REPOSITORY_PRODUCTION_OPERATOR_URL;
  if (endpoint === undefined || endpoint === "") {
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
  return createAuthSchemaRolloutClient({
    endpoint,
    ownerContext,
    callId: ctx.callId,
    signal: ctx.abortSignal,
    workloadToken: async () => await createVercelWorkloadIdentity().token(),
    fetch,
  });
};
