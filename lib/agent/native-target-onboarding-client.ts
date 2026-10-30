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
  nativeTargetTransportRequestSchema,
  nativeTargetTransportResponseSchemas,
} from "../provisioning/native-target-onboarding-transport";
import type { NativeTargetTransportRequest } from "../provisioning/native-target-onboarding-transport";
import { nativeTargetOnboardingPlanDigest } from "../provisioning/native-target-onboarding-contract";
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
    request: NativeTargetTransportRequest,
    schema: z.ZodType<Result>,
    signal?: AbortSignal,
  ): Promise<Result> => {
    signal?.throwIfAborted();
    const body = nativeTargetTransportRequestSchema.parse(request);
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
    async plan(input, ctx, state) {
      if (state.appSpec === undefined || state.appSpec.appId !== input.appId) {
        throw denied();
      }
      const output = await send(
        {
          ...common(ctx),
          action: "native-target-plan",
          input,
          selectedApp: { appId: state.appSpec.appId, appSpecDigest: state.appSpec.digest },
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
