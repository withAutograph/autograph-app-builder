import { nativeTargetAuthOnlyEntryApprovalInputSchema } from "../provisioning/native-target-auth-only-entry-plan-store";
import { nativeTargetAuthOnlyEntryApprovalTool } from "../eve/private-native-target-auth-only-entry-approval";
import {
  nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
  nativeTargetAuthOnlyFinalRoutingPlanInputSchema,
  nativeTargetAuthOnlyFinalRoutingApprovalTool,
} from "../eve/private-native-target-auth-only-final-routing-approval";
import { z } from "zod";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import type { HostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import {
  HostedOperatorError,
  operatorOwnerContextSchema,
  operatorPublicResultSchema,
} from "../provisioning/hosted-operator-contract";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import {
  nativeTargetAuthOnlyPlanRequestSchema,
  nativeTargetAuthOnlyDeliveryPlanInputSchema,
  nativeTargetAuthOnlyEntryPlanInputSchema,
  nativeTargetAuthOnlyDispatchResultSchema,
  nativeTargetAuthOnlyPreparationRequestSchema,
  nativeTargetAuthOnlyPlanResponseSchema,
  nativeTargetTransportRequestSchema,
  nativeTargetTransportResponseSchemas,
} from "../provisioning/native-target-onboarding-transport";
import type { NativeTargetRequest } from "../provisioning/native-target-onboarding-transport";
import { nativeTargetOnboardingPlanDigest } from "../provisioning/native-target-onboarding-contract";
import { nativeTargetAuthOnlyDeliveryPreparationInputSchema, nativeTargetAuthOnlyDeliveryApprovalTool } from "../eve/private-native-target-auth-only-delivery-approval";
import { nativeTargetAuthOnlyResourcePreparationInputSchema, nativeTargetAuthOnlyResourceApprovalTool } from "../eve/private-native-target-auth-only-resource-approval";
import type {
  NativeTargetInvocation,
  NativeTargetOnboardingRuntime,
  NativeTargetPreparationRequest,
  NativeTargetRuntimeResolutionContext,
} from "./native-target-onboarding-runtime";

const unavailable = () => new HostedOperatorError("operator_unavailable");
const denied = () => new HostedOperatorError("authorization_required");
const blockedAppMatches = (actual: string, expected: string) =>
  actual === expected || actual === "unknown";

export const createNativeTargetOnboardingClient = (options: {
  endpoint: string;
  ownerContext: OperatorOwnerContext;
  token: () => Promise<string>;
  fetch?: typeof fetch;
  allowLoopback?: boolean;
  execution?: HostedOperatorCallbackExecution;
}): NativeTargetOnboardingRuntime => {
  const owner = operatorOwnerContextSchema.parse(options.ownerContext);
  const execution = options.execution === undefined ? undefined : { ...options.execution };
  const url = new URL(options.endpoint);
  const loopback =
    options.allowLoopback === true && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (
    ![
      url.protocol === "https:" || loopback,
      url.username === "",
      url.password === "",
      url.pathname === "/",
      url.search === "",
      url.hash === "",
    ].every(Boolean)
  ) {
    throw new HostedOperatorError("protected_operator_required");
  }
  const send = async <Result>(
    request: NativeTargetRequest,
    schema: z.ZodType<Result>,
    signal?: AbortSignal,
  ): Promise<Result> => {
    signal?.throwIfAborted();
    const body =
      request.action === "native-target-auth-only-plan"
        ? nativeTargetAuthOnlyPlanRequestSchema.parse(request)
        : nativeTargetTransportRequestSchema.parse(request);
    if (body.adapterSessionId !== owner.adapterSessionId) {
      throw denied();
    }
    const token = await options.token();
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(new URL("/v1/runtime", url), {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-vercel-trusted-oidc-idp-token": token,
        },
        body: JSON.stringify(body),
      });
    } catch {
      signal?.throwIfAborted();
      // Never repeat an uncertain request here. The protected journal owns recovery.
      console.warn("[builder:native-target-transport]", {
        action: body.action,
        failure: "transport",
      });
      throw unavailable();
    }
    signal?.throwIfAborted();
    if (response.status === 401 || response.status === 403) {
      console.warn("[builder:native-target-transport]", {
        action: body.action,
        failure: "authorization",
        status: response.status,
      });
      throw denied();
    }
    if (body.action === "native-target-plan" && response.status === 409) {
      let existingBody: unknown;
      try {
        existingBody = await response.json();
      } catch {
        throw unavailable();
      }
      const existing = z
        .strictObject({
          code: z.literal("native_target_existing_configured_target"),
          nextAction: z.literal("resolve-preview-target"),
        })
        .safeParse(existingBody);
      if (existing.success) {
        throw new Error(
          "This app already has a dedicated Preview target. Continue with plan-app-hosted-runtime for that existing target.",
        );
      }
      throw unavailable();
    }
    if (!response.ok) {
      console.warn("[builder:native-target-transport]", {
        action: body.action,
        failure: "http",
        status: response.status,
      });
      throw unavailable();
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      console.warn("[builder:native-target-transport]", {
        action: body.action,
        failure: "invalid_json",
      });
      throw unavailable();
    }
    const blocked = operatorPublicResultSchema.safeParse(raw);
    if (
      blocked.success &&
      blocked.data.status === "blocked" &&
      blockedAppMatches(blocked.data.appId, body.input.appId) &&
      blocked.data.code !== undefined
    ) {
      console.warn("[builder:native-target-transport]", {
        action: body.action,
        failure: blocked.data.code,
      });
      throw new HostedOperatorError(blocked.data.code);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[builder:native-target-transport]", {
        action: body.action,
        failure: "invalid_response",
      });
      throw unavailable();
    }
    return parsed.data;
  };
  const assertInvocation = (session: Parameters<typeof hostedOperatorCallbackExecution>[0]) => {
    const observed = hostedOperatorCallbackExecution(session);
    const matches =
      execution === undefined
        ? session.id === owner.adapterSessionId
        : (["logicalSessionId", "ownerRunId", "ownerAnchorRunId"] as const).every(
            (key) => observed[key] === execution[key],
          );
    if (!matches) {
      throw denied();
    }
  };
  const common = (ctx: NativeTargetInvocation) => {
    assertInvocation(ctx.session);
    return {
      ownerContext: owner,
      adapterSessionId: owner.adapterSessionId,
      callId: ctx.callId,
    };
  };
  const exactResult = (
    input: NativeTargetPreparationRequest,
    output: NativeTargetPreparationRequest,
  ) => {
    if (
      ![
        input.appId === output.appId,
        input.operationRef === output.operationRef,
        input.planDigest === output.planDigest,
        nativeTargetOnboardingPlanDigest(output.plan) === input.planDigest,
      ].every(Boolean)
    ) {
      throw denied();
    }
  };
  return {
    async planAuthOnly(input, ctx, state) {
      if (state.appSpec === undefined || state.appSpec.appId !== input.appId) {
        throw denied();
      }
      const selectedApp = { appId: state.appSpec.appId, appSpecDigest: state.appSpec.digest };
      const output = await send(
        {
          ...common(ctx),
          action: "native-target-auth-only-plan",
          input,
          selectedApp,
        },
        nativeTargetAuthOnlyPlanResponseSchema,
        ctx.abortSignal,
      );
      if (
        output.plan.appId !== input.appId ||
        output.plan.origin.appSpecDigest !== selectedApp.appSpecDigest ||
        output.plan.authResource.profileId !== input.authProfileId
      ) {
        throw denied();
      }
      return output;
    },
    async prepareAuthOnly(input, ctx) {
      const proposal = nativeTargetAuthOnlyPreparationRequestSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-prepare", input: proposal },
        nativeTargetAuthOnlyDispatchResultSchema,
        ctx.abortSignal,
      );
      if (output.status === "created" && output.projectId.trim() === "") throw denied();
      return output;
    },
    async hasAuthOnlyApproval(input, ctx) {
      const proposal = nativeTargetAuthOnlyPreparationRequestSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-approval-read", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-approval-read"],
        ctx.abortSignal,
      );
      return output.status === "approved";
    },
    async prepareAuthOnlyResources(input, ctx) {
      const proposal = nativeTargetAuthOnlyResourcePreparationInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-resources", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-resources"],
        ctx.abortSignal,
      );
      if (output.resourcePlanDigest !== proposal.resourcePlanDigest) throw denied();
      return output;
    },
    async hasAuthOnlyResourceApproval(input, ctx) {
      const proposal = nativeTargetAuthOnlyResourcePreparationInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-resource-approval-read", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-resource-approval-read"],
        ctx.abortSignal,
      );
      return output.status === "approved";
    },
    async planAuthOnlyEntry(input, ctx) {
      const proposal = nativeTargetAuthOnlyEntryPlanInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-entry-plan", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-entry-plan"],
        ctx.abortSignal,
      );
      if (
        output.appId !== proposal.appId || output.deliveryOperationRef !== proposal.deliveryOperationRef ||
        output.deliveryPlanDigest !== proposal.deliveryPlanDigest || output.effect !== proposal.effect
      ) throw denied();
      return output;
    },
    async prepareAuthOnlyEntry(input, ctx) {
      const proposal = nativeTargetAuthOnlyEntryApprovalInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-entry", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-entry"],
        ctx.abortSignal,
      );
      if (
        output.effect !== proposal.effect || output.childOperationRef !== proposal.childOperationRef ||
        output.childPlanDigest !== proposal.childPlanDigest
      ) throw denied();
      return output;
    },
    async hasAuthOnlyEntryApproval(input, ctx) {
      const proposal = nativeTargetAuthOnlyEntryApprovalInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-entry-approval-read", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-entry-approval-read"],
        ctx.abortSignal,
      );
      return output.status === "approved";
    },
    async authorizeAuthOnlyEntryApprovalResponse(ctx) {
      assertInvocation(ctx.session);
      if (ctx.request.toolInput === undefined || ctx.request.toolName !== nativeTargetAuthOnlyEntryApprovalTool) throw denied();
      nativeTargetAuthOnlyEntryApprovalInputSchema.parse(ctx.request.toolInput);
      if (
        ctx.responder.principalId !== owner.authority.ownerUserId || ctx.responder.principalType !== "user"
      ) throw denied();
      // The deployment route binds these digest-only references to the retained
      // owner/session plan and actual settled approval before any child effect.
    },
    async planAuthOnlyFinalRouting(input, ctx) {
      const proposal = nativeTargetAuthOnlyFinalRoutingPlanInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-final-routing-plan", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-final-routing-plan"],
        ctx.abortSignal,
      );
      if (
        output.appId !== proposal.appId || output.operationRef !== proposal.operationRef ||
        output.deliveryPlanDigest !== proposal.deliveryPlanDigest
      ) throw denied();
      return output;
    },
    async prepareAuthOnlyFinalRouting(input, ctx) {
      const proposal = nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-final-routing", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-final-routing"],
        ctx.abortSignal,
      );
      if (
        output.deliveryPlanDigest !== proposal.deliveryPlanDigest ||
        output.gateway.operationRef !== proposal.routingOperationRef ||
        output.app.operationRef !== proposal.operationRef ||
        output.gateway.projectId === output.app.projectId ||
        output.gateway.deploymentId === output.app.deploymentId
      ) throw denied();
      return output;
    },
    async hasAuthOnlyFinalRoutingApproval(input, ctx) {
      const proposal = nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-final-routing-approval-read", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-final-routing-approval-read"],
        ctx.abortSignal,
      );
      return output.status === "approved";
    },
    async authorizeAuthOnlyFinalRoutingApprovalResponse(ctx) {
      assertInvocation(ctx.session);
      if (ctx.request.toolInput === undefined || ctx.request.toolName !== nativeTargetAuthOnlyFinalRoutingApprovalTool) throw denied();
      nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.parse(ctx.request.toolInput);
      if (ctx.responder.principalId !== owner.authority.ownerUserId || ctx.responder.principalType !== "user") throw denied();
      // The private route resolves these references to the exact same-session retained
      // routing bytes and observes the original settled approval before any effect.
    },
    async planAuthOnlyDelivery(input, ctx) {
      const proposal = nativeTargetAuthOnlyDeliveryPlanInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-delivery-plan", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-delivery-plan"],
        ctx.abortSignal,
      );
      if (
        output.appId !== proposal.appId || output.operationRef !== proposal.operationRef ||
        output.planDigest !== proposal.planDigest || output.resourcePlanDigest !== proposal.resourcePlanDigest ||
        output.deliveryPlan.target.appId !== proposal.appId || output.deliveryPlan.target.sessionId !== owner.sessionId ||
        output.deliveryPlan.authOnlyPlanDigest !== proposal.planDigest || output.deliveryPlan.resourcePlanDigest !== proposal.resourcePlanDigest
      ) throw denied();
      return output;
    },
    async prepareAuthOnlyDelivery(input, ctx) {
      const proposal = nativeTargetAuthOnlyDeliveryPreparationInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-delivery", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-delivery"],
        ctx.abortSignal,
      );
      if (output.deliveryPlanDigest !== proposal.deliveryPlanDigest) throw denied();
      if (output.status === "pending-owner") return output;
      if (
        output.status === "routing-required" &&
        (output.finalRoutingPlan.appId !== proposal.appId ||
          output.finalRoutingPlan.operationRef !== proposal.operationRef ||
          output.finalRoutingPlan.deliveryPlanDigest !== proposal.deliveryPlanDigest)
      ) throw denied();
      const finalRoutingPlan = output.status === "prepared" ? output.finalRoutingPlan : undefined;
      if (
        finalRoutingPlan !== undefined &&
        (finalRoutingPlan.appId !== proposal.appId ||
          finalRoutingPlan.operationRef !== proposal.operationRef ||
          finalRoutingPlan.deliveryPlanDigest !== proposal.deliveryPlanDigest ||
          finalRoutingPlan.routingOperationRef === proposal.operationRef)
      ) throw denied();
      const app = proposal.deliveryPlan.delivery.delivery;
      const gateway = proposal.deliveryPlan.delivery.gatewayDelivery;
      if (
        app === undefined || gateway === undefined ||
        output.app.projectId !== app.projectId || output.app.branch !== app.branch || output.app.repoId !== app.repoId || output.app.operationRef !== proposal.operationRef ||
        output.gateway.projectId !== gateway.projectId || output.gateway.branch !== gateway.branch || output.gateway.repoId !== gateway.repoId || output.gateway.operationRef !== (finalRoutingPlan?.routingOperationRef ?? proposal.operationRef)
      ) throw denied();
      return output;
    },
    async hasAuthOnlyDeliveryApproval(input, ctx) {
      const proposal = nativeTargetAuthOnlyDeliveryPreparationInputSchema.parse(input);
      const output = await send(
        { ...common(ctx), action: "native-target-auth-only-delivery-approval-read", input: proposal },
        nativeTargetTransportResponseSchemas["native-target-auth-only-delivery-approval-read"],
        ctx.abortSignal,
      );
      return output.status === "approved";
    },
    async authorizeAuthOnlyDeliveryApprovalResponse(ctx) {
      assertInvocation(ctx.session);
      if (ctx.request.toolInput === undefined || ctx.request.toolName !== nativeTargetAuthOnlyDeliveryApprovalTool) throw denied();
      const proposal = nativeTargetAuthOnlyDeliveryPreparationInputSchema.parse(ctx.request.toolInput);
      if (
        proposal.appId !== proposal.deliveryPlan.target.appId || proposal.deliveryPlan.target.sessionId !== owner.sessionId ||
        proposal.deliveryPlan.authOnlyPlanDigest !== proposal.planDigest || proposal.deliveryPlan.resourcePlanDigest !== proposal.resourcePlanDigest ||
        ctx.responder.principalId !== owner.authority.ownerUserId || ctx.responder.principalType !== "user"
      ) throw denied();
    },
    async authorizeAuthOnlyResourceApprovalResponse(ctx) {
      assertInvocation(ctx.session);
      if (ctx.request.toolInput === undefined || ctx.request.toolName !== nativeTargetAuthOnlyResourceApprovalTool) throw denied();
      const proposal = nativeTargetAuthOnlyResourcePreparationInputSchema.parse(ctx.request.toolInput);
      if (
        proposal.resourcePlan.authOnlyPlanDigest !== proposal.planDigest ||
        proposal.appId !== proposal.resourcePlan.target.appId ||
        proposal.resourcePlan.target.sessionId !== owner.sessionId ||
        ctx.responder.principalId !== owner.authority.ownerUserId ||
        ctx.responder.principalType !== "user"
      ) throw denied();
    },
    async authorizeAuthOnlyApprovalResponse(ctx) {
      assertInvocation(ctx.session);
      if (ctx.request.toolName !== "prepare-app-native-target-auth-only" || ctx.request.toolInput === undefined) throw denied();
      const proposal = nativeTargetAuthOnlyPreparationRequestSchema.parse(ctx.request.toolInput);
      if (
        proposal.appId !== ctx.request.toolInput.appId ||
        proposal.plan.origin.authority.ownerUserId !== owner.authority.ownerUserId ||
        ctx.responder.principalId !== owner.authority.ownerUserId ||
        ctx.responder.principalType !== "user"
      ) throw denied();
    },
    async plan(input, ctx, state) {
      if (state.appSpec !== undefined && state.appSpec.appId !== input.appId) {
        throw denied();
      }
      const output = await send(
        {
          ...common(ctx),
          action: "native-target-plan",
          input,
          ...(state.appSpec === undefined
            ? {}
            : { selectedApp: { appId: state.appSpec.appId, appSpecDigest: state.appSpec.digest } }),
        },
        nativeTargetTransportResponseSchemas["native-target-plan"],
        ctx.abortSignal,
      );
      if (
        output.appId !== input.appId ||
        nativeTargetOnboardingPlanDigest(output.plan) !== output.planDigest
      ) {
        throw denied();
      }
      return output;
    },
    async prepare(input, ctx) {
      const output = await send(
        { ...common(ctx), action: "native-target-prepare", input },
        nativeTargetTransportResponseSchemas["native-target-prepare"],
        ctx.abortSignal,
      );
      exactResult(input, output);
      return output;
    },
    async hasApproval(input, ctx) {
      const output = await send(
        { ...common(ctx), action: "native-target-approval-read", input },
        nativeTargetTransportResponseSchemas["native-target-approval-read"],
        ctx.abortSignal,
      );
      if (output.status === "pending") {
        return false;
      }
      if (
        ![
          output.proof.planDigest === input.planDigest,
          output.proof.publicSessionId === input.plan.origin.publicSessionId,
          output.proof.responderPrincipalId === owner.authority.ownerUserId,
          output.status === "approved",
        ].every(Boolean)
      ) {
        throw denied();
      }
      return true;
    },
    async authorizeApprovalResponse(ctx) {
      assertInvocation(ctx.session);
      if (
        ctx.request.toolInput === undefined ||
        ctx.request.toolName !== "prepare-app-native-target"
      ) {
        throw denied();
      }
      const responder = ctx.responder;
      if (
        responder.principalId !== owner.authority.ownerUserId ||
        responder.principalType !== "user"
      ) {
        throw denied();
      }
      await send(
        {
          ownerContext: owner,
          adapterSessionId: owner.adapterSessionId,
          callId: ctx.request.callId,
          action: "native-target-approval-candidate",
          input: ctx.request.toolInput,
          candidate: {
            requestId: ctx.request.requestId,
            callId: ctx.request.callId,
            toolName: ctx.request.toolName,
            responder: {
              authenticator: responder.authenticator,
              principalId: responder.principalId,
              principalType: responder.principalType,
              ...(responder.issuer === undefined ? {} : { issuer: responder.issuer }),
              ...(responder.subject === undefined ? {} : { subject: responder.subject }),
            },
          },
        },
        nativeTargetTransportResponseSchemas["native-target-approval-candidate"],
      );
    },
  };
};

export const nativeTargetOnboardingClientForContext = async (
  ctx: NativeTargetRuntimeResolutionContext,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: { resolveOwner?: typeof resolveHostedOperatorOwnerContext } = {},
): Promise<NativeTargetOnboardingRuntime> => {
  const endpoint = environment.HOSTED_RUNTIME_OPERATOR_URL;
  if (endpoint === undefined || endpoint === "") {
    throw new HostedOperatorError("protected_operator_required");
  }
  // Both identities originate in Eve's authenticated callback. Never fill missing owner facts.
  const sessionAuth =
    "responder" in ctx
      ? { current: ctx.responder, initiator: ctx.session.initiator }
      : ctx.session.auth;
  const execution = hostedOperatorCallbackExecution(ctx.session);
  const { authority, principal } = exactForwardedSessionAuthority(sessionAuth, {
    realmContinuation: { adapterSessionId: execution.ownerAnchorRunId ?? ctx.session.id },
  });
  const ownerContext = await (dependencies.resolveOwner ?? resolveHostedOperatorOwnerContext)({
    adapterSessionId: ctx.session.id,
    authority,
    principal,
    sessionAuth,
    environment,
    execution,
  });
  return createNativeTargetOnboardingClient({
    endpoint,
    ownerContext,
    execution,
    token: createVercelWorkloadIdentity().token,
  });
};
