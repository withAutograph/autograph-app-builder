import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { WorkflowStepToolContext } from "eve/tools";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import {
  repositoryProductionApprovalInputSchema,
  repositoryProductionApprovalReference,
  repositoryProductionPrepareInputSchema,
} from "../provisioning/repository-production-approval";
import type {
  RepositoryProductionApprovalReference,
  RepositoryProductionPrepareInput,
} from "../provisioning/repository-production-approval";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import { appAccessSnapshotSchema } from "../app-access/contracts";
import { describeAppAccessIntent } from "./app-access-intent";
import {
  repositoryProductionDeliveryStatusSchema,
  repositoryProductionDeliveryTargetSchema,
} from "../provisioning/repository-production-delivery";
import type { RepositoryProductionDeliveryTarget } from "../provisioning/repository-production-delivery";
import { retainManagedProductionDeliveryRequirement } from "./production-delivery-requirement";
import { repositoryProductionNativeStatusSchema } from "../provisioning/repository-production-native-status-contract";

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
// oxlint-disable-next-line sonarjs/max-union-size -- Each protected setup/read action has distinct existing service handling.
type RepositoryProductionAction =
  | "plan"
  | "prepare"
  | "setup-status"
  | "delivery-status"
  | "native-status";

export class RepositoryProductionNativeAccessChangedError extends Error {
  constructor() {
    super("Builder stopped checking this app after its saved access or destination changed.");
    this.name = "RepositoryProductionNativeAccessChangedError";
  }
}

interface RepositoryProductionRequestExtras {
  approvedByCallId?: string;
  creatorEmail?: string;
  repositoryId?: string;
  repositoryFullName?: string;
  reviewedHeadSha?: string;
  approvalReference?: RepositoryProductionApprovalReference;
}

const repositoryProductionErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const failure = z.object({ code: z.string() }).safeParse(await response.json());
    return failure.success ? failure.data.code : undefined;
  } catch {
    return undefined;
  }
};

/** A failed read is not evidence that preparation ran or changed a resource. */
export const repositoryProductionResponseError = async (
  response: Response,
  action: RepositoryProductionAction,
): Promise<Error> => {
  if (action === "native-status") {
    return response.status === 403
      ? new RepositoryProductionNativeAccessChangedError()
      : new Error("Builder could not check this app’s current availability.");
  }
  const code = await repositoryProductionErrorCode(response);
  if (code === "app_setup_destination_required") {
    return new Error(
      "Builder could not yet resolve this app's repository and current source for Production. Continue its saved delivery in the same session, then check Production setup again.",
    );
  }
  return new Error(
    action === "prepare"
      ? "Your app setup is saved. Builder could not confirm the latest result. Check its status before retrying."
      : "Builder could not read this app's Production setup. This read did not start setup. Keep the same app and session while restoring access to its saved setup.",
  );
};

const repositoryProductionEndpoint = (value: string) => {
  // react-doctor-disable-next-line react-doctor/no-unguarded-throwing-parse-call -- Invalid operator configuration must fail before any protected request.
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
  return endpoint;
};

/** The native service remains authoritative for current owner, captured release and approval. */
export const createRepositoryProductionClient = (input: {
  endpoint: string;
  ownerContext: OperatorOwnerContext;
  callId: string;
  signal: AbortSignal;
  workloadToken: () => Promise<string>;
  fetch: typeof fetch;
}) => {
  const endpoint = repositoryProductionEndpoint(input.endpoint);
  const { ownerContext } = input;
  const request = async (
    appId: string,
    action: RepositoryProductionAction,
    extra: RepositoryProductionRequestExtras,
  ) => {
    input.signal.throwIfAborted();
    const workload = await input.workloadToken();
    const response = await input.fetch(new URL("/v1/repository-production", endpoint), {
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
        appId,
        sessionId: ownerContext.sessionId,
        ownerContext,
        ...extra,
      }),
    });
    input.signal.throwIfAborted();
    return response;
  };
  const send = async <T>(
    appId: string,
    action: RepositoryProductionAction,
    schema: z.ZodType<T>,
    extra: RepositoryProductionRequestExtras = {},
  ) => {
    let response = await request(appId, action, extra);
    const withReviewedHead = action === "delivery-status" && extra.reviewedHeadSha !== undefined;
    if (
      withReviewedHead &&
      response.status === 400 &&
      (await repositoryProductionErrorCode(response.clone())) === "request_invalid"
    ) {
      // Older operators reject the additional field before their strict same-session read.
      response = await request(appId, action, {
        repositoryId: extra.repositoryId,
        repositoryFullName: extra.repositoryFullName,
      });
    }
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
        result.plan.intent.sessionId !== ownerContext.sessionId ||
        !isDeepStrictEqual(result.plan.scope.authority, ownerContext.authority)
      ) {
        throw new Error("app_setup_scope_mismatch");
      }
      retainManagedProductionDeliveryRequirement({
        appId,
        repositoryId: result.plan.scope.repositoryId,
        repositoryFullName: result.plan.scope.repositoryFullName,
        operationRef: result.plan.operationRef,
      });
      const approvalReference = repositoryProductionApprovalReference(result.plan);
      return {
        ...result,
        approvalReference,
        nextCall: { tool: "prepare-app-production" as const, input: approvalReference },
        accessSummary: describeAppAccessIntent(result.plan.scope.appId, result.plan.intent.access),
      };
    },
    prepare: async (value: RepositoryProductionPrepareInput, directProductionCallId?: string) => {
      const plan = repositoryProductionPrepareInputSchema.parse(value);
      if (
        "scope" in plan &&
        (plan.intent.sessionId !== ownerContext.sessionId ||
          !isDeepStrictEqual(plan.scope.authority, ownerContext.authority))
      ) {
        throw new Error("app_setup_scope_mismatch");
      }
      const { appId, repositoryId, repositoryFullName, creatorEmail } =
        "version" in plan
          ? {
              appId: plan.appId,
              repositoryId: plan.repositoryId,
              repositoryFullName: plan.review.repositoryFullName,
              creatorEmail: plan.review.creatorEmail,
            }
          : { ...plan.scope, creatorEmail: plan.intent.creatorEmail };
      const extra: RepositoryProductionRequestExtras = {
        approvedByCallId: directProductionCallId ?? input.callId,
      };
      if (creatorEmail !== undefined && directProductionCallId === undefined) {
        extra.creatorEmail = creatorEmail;
      }
      if ("version" in plan) {
        extra.approvalReference = plan;
      }
      const result = await send(
        appId,
        "prepare",
        appAccessSnapshotSchema.extend({ version: z.literal(1), setup: setupSchema }),
        extra,
      );
      if (
        result.appId !== appId ||
        result.sessionId !== ownerContext.sessionId ||
        result.setup.operationRef !== plan.operationRef
      ) {
        throw new Error("app_setup_scope_mismatch");
      }
      retainManagedProductionDeliveryRequirement({
        appId,
        repositoryId,
        repositoryFullName,
        operationRef: result.setup.operationRef,
      });
      return result;
    },
    status: async (appId: string) =>
      await send(appId, "setup-status", setupSchema.extend({ version: z.literal(1) })),
    nativeStatus: async (appId: string) => {
      const result = await send(appId, "native-status", repositoryProductionNativeStatusSchema);
      if (result.appId !== appId) {
        throw new RepositoryProductionNativeAccessChangedError();
      }
      return result;
    },
    deliveryStatus: async (appId: string, target: RepositoryProductionDeliveryTarget) => {
      const result = await send(
        appId,
        "delivery-status",
        repositoryProductionDeliveryStatusSchema,
        repositoryProductionDeliveryTargetSchema.parse(target),
      );
      if (
        result.appId !== appId ||
        result.repositoryId !== target.repositoryId ||
        result.repositoryFullName !== target.repositoryFullName
      ) {
        throw new Error("app_setup_scope_mismatch");
      }
      return result;
    },
  };
};

/** Workload-authenticated calls retain the canonical Builder owner and session. */
export const repositoryProductionClientForContext = async (ctx: WorkflowStepToolContext) => {
  const value = process.env.REPOSITORY_PRODUCTION_OPERATOR_URL;
  if (value === undefined || value === "") {
    throw new Error("protected_operator_required");
  }
  const endpoint = repositoryProductionEndpoint(value);
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
  return createRepositoryProductionClient({
    endpoint: endpoint.href,
    ownerContext,
    callId: ctx.callId,
    signal: ctx.abortSignal,
    workloadToken: async () => await createVercelWorkloadIdentity().token(),
    fetch,
  });
};
