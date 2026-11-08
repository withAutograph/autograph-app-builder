import { z } from "zod";
import type { WorkflowStepToolContext } from "eve/tools";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import { repositoryProductionApprovalInputSchema } from "../provisioning/repository-production-approval";
import type { RepositoryProductionApprovalInput } from "../provisioning/repository-production-approval";
import { appAccessSnapshotSchema } from "../app-access/contracts";

const setupSchema = z.object({
  operationRef: z.uuid(),
  state: z.enum([
    "ready",
    "identity-required",
    "setting-up-data",
    "checking-access",
    "reconciling",
  ]),
  signInUrl: z.url().optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

/** A failed read is not evidence that preparation ran or changed a resource. */
export const repositoryProductionResponseError = async (
  response: Response,
  action: "plan" | "prepare" | "setup-status",
): Promise<Error> => {
  let code = "";
  try {
    const failure = z.object({ code: z.string() }).safeParse(await response.json());
    if (failure.success) {
      ({ code } = failure.data);
    }
  } catch {
    // A non-JSON transport failure retains the ordinary uncertainty message.
  }
  if (code === "app_setup_destination_required") {
    return new Error(
      "Builder could not read this app's saved repository destination. Continue its existing reviewed publication workflow in the same session, then check Production setup again. Keep the acquired app source unchanged.",
    );
  }
  return new Error(
    action === "prepare"
      ? "Your app setup is saved. Builder could not confirm the latest result. Check its status before retrying."
      : "Builder could not read this app's Production setup. This read did not start setup. Keep the same app and session while restoring access to its saved setup.",
  );
};

/** Workload-authenticated calls retain the canonical Builder owner and session. */
export const repositoryProductionClientForContext = async (ctx: WorkflowStepToolContext) => {
  const value = process.env.REPOSITORY_PRODUCTION_OPERATOR_URL;
  if (value === undefined || value === "") {
    throw new Error("protected_operator_required");
  }
  const endpoint = new URL(value);
  const validOrigin = [
    endpoint.protocol === "https:",
    endpoint.username === "",
    endpoint.password === "",
    endpoint.pathname === "/",
    endpoint.search === "",
    endpoint.hash === "",
  ].every(Boolean);
  if (!validOrigin) {
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
  const send = async <T>(
    appId: string,
    action: "plan" | "prepare" | "setup-status",
    schema: z.ZodType<T>,
    extra: { approvedByCallId?: string; creatorEmail?: string } = {},
  ) => {
    ctx.abortSignal.throwIfAborted();
    const workload = await createVercelWorkloadIdentity().token();
    const response = await fetch(new URL("/v1/repository-production", endpoint), {
      method: "POST",
      redirect: "error",
      signal: ctx.abortSignal,
      headers: {
        authorization: `Bearer ${workload}`,
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": workload,
      },
      body: JSON.stringify({
        version: 1,
        action,
        appId,
        sessionId: ownerContext.sessionId,
        ownerContext,
        ...extra,
      }),
    });
    ctx.abortSignal.throwIfAborted();
    if (!response.ok) {
      throw await repositoryProductionResponseError(response, action);
    }
    return schema.parse(await response.json());
  };
  return {
    plan: async (appId: string, creatorEmail?: string) => {
      const result = await send(
        appId,
        "plan",
        z.object({ version: z.literal(1), plan: repositoryProductionApprovalInputSchema }),
        creatorEmail === undefined ? {} : { creatorEmail },
      );
      if (
        result.plan.scope.appId !== appId ||
        result.plan.intent.sessionId !== ownerContext.sessionId
      ) {
        throw new Error("app_setup_scope_mismatch");
      }
      return result;
    },
    prepare: async (input: RepositoryProductionApprovalInput) => {
      const plan = repositoryProductionApprovalInputSchema.parse(input);
      if (plan.intent.sessionId !== ownerContext.sessionId) {
        throw new Error("app_setup_scope_mismatch");
      }
      const result = await send(
        plan.scope.appId,
        "prepare",
        appAccessSnapshotSchema.extend({ version: z.literal(1), setup: setupSchema }),
        {
          approvedByCallId: ctx.callId,
          ...(plan.intent.creatorEmail === undefined
            ? {}
            : { creatorEmail: plan.intent.creatorEmail }),
        },
      );
      if (
        result.appId !== plan.scope.appId ||
        result.sessionId !== ownerContext.sessionId ||
        result.setup.operationRef !== plan.operationRef
      ) {
        throw new Error("app_setup_scope_mismatch");
      }
      return result;
    },
    status: async (appId: string) =>
      await send(appId, "setup-status", setupSchema.extend({ version: z.literal(1) })),
  };
};
