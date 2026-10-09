import { reportHostedOperatorCallerWorkload } from "./hosted-operator-caller-workload";
import { createHostedOperatorConsentDiagnostic } from "./hosted-operator-consent-diagnostic";
import type { HostedOperatorConsentMetadata } from "./hosted-operator-consent-diagnostic";
import { neonAuthorizationResultSchema } from "./hosted-operator-neon-authorization";
import { z } from "zod";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { hostedRuntimeProofSchema } from "./hosted-runtime-journal";
import { resolveHostedOperatorOwnerContext } from "./hosted-operator-owner-context";
import type { OperatorOwnerContext, OperatorRequest } from "./hosted-operator-contract";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPublicResultSchema,
  operatorAuthIdentityInputSchema,
  operatorRequestSchema,
  restrictedOperatorEnvironment,
  sameOperatorSelection,
} from "./hosted-operator-contract";

const bindingSchema = z.strictObject({
  environment: z.record(z.string(), z.string()),
  operationRef: z.uuid(),
  plan: hostedOperatorPlanSchema,
  proof: hostedRuntimeProofSchema,
});
/** Server-only client. An unconfigured service never falls back to an installer Sandbox. */
export const createHostedOperatorClient = (input: {
  endpoint: string;
  token: () => Promise<string>;
  ownerContext?: OperatorOwnerContext | null;
  sessionId?: string;
  fetch?: typeof fetch;
  allowLoopback?: boolean;
}) => {
  const url = new URL(input.endpoint);
  const loopback =
    input.allowLoopback === true && url.protocol === "http:" && url.hostname === "127.0.0.1";
  const validEndpoint = [
    url.protocol === "https:" || loopback,
    url.username === "",
    url.password === "",
    url.pathname === "/",
    url.search === "",
    url.hash === "",
  ];
  if (validEndpoint.includes(false)) {
    throw new HostedOperatorError("protected_operator_required");
  }
  const send = async (request: OperatorRequest, signal?: AbortSignal) => {
    const bodyInput =
      input.ownerContext === undefined || input.ownerContext === null
        ? request
        : { ...request, ownerContext: input.ownerContext };
    const body = operatorRequestSchema.parse(bodyInput);
    const token = await input.token();
    const response = await (input.fetch ?? fetch)(new URL("/v1/runtime", url), {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": token,
      },
      method: "POST",
      redirect: "error",
      signal,
    });
    const isConsentRequest = body.action === "neon-authorization";
    const diagnosticSessionId = isConsentRequest ? body.sessionId : body.selection.sessionId;
    const diagnosticPhase = isConsentRequest ? body.phase : "inline";
    const report = createHostedOperatorConsentDiagnostic(diagnosticSessionId);
    const emit = (accessClass: NonNullable<HostedOperatorConsentMetadata["accessClass"]>) => {
      const vercelError = response.headers.get("x-vercel-error");
      let outcome: HostedOperatorConsentMetadata["outcome"] = "operator_access_denied";
      if (accessClass === "ok") {
        outcome = "verified";
      }
      if (accessClass === "other_failed") {
        outcome = "setup_unavailable";
      }
      const metadata: HostedOperatorConsentMetadata = {
        accessClass,
        boundary: "builder",
        httpStatus: response.status,
        outcome,
        phase: diagnosticPhase,
        stage: "operator_request",
      };
      if (vercelError === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH") {
        metadata.vercelError = "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH";
      }
      report(metadata);
    };
    if (!response.ok) {
      emit(
        response.status === 401 || response.status === 403
          ? "upstream_auth_denied"
          : "other_failed",
      );
      if (response.status === 401 || response.status === 403) {
        await reportHostedOperatorCallerWorkload({
          httpStatus: response.status,
          phase: diagnosticPhase,
          sessionId:
            body.action === "neon-authorization" ? body.sessionId : body.selection.sessionId,
          token,
        });
      }
      throw new HostedOperatorError(
        response.status === 401 || response.status === 403
          ? "authorization_required"
          : "operator_unavailable",
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      emit("other_failed");
      throw error;
    }
    const blocked = operatorPublicResultSchema.safeParse(value);
    let accessClass: NonNullable<HostedOperatorConsentMetadata["accessClass"]> = "ok";
    if (blocked.success && blocked.data.status === "blocked") {
      accessClass =
        blocked.data.code === "authorization_required" ? "application_auth_denied" : "other_failed";
    }
    emit(accessClass);
    return value;
  };
  return {
    async authIdentityInput(
      request: Extract<OperatorRequest, { action: "auth-identity-input" }>,
      signal?: AbortSignal,
    ) {
      const value = operatorAuthIdentityInputSchema.parse(await send(request, signal));
      if (
        value.operationRef !== request.operationRef ||
        value.sessionId !== request.selection.sessionId
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return value;
    },
    async bindings(
      request: Extract<OperatorRequest, { action: "bindings" }>,
      signal?: AbortSignal,
    ) {
      const raw = await send(request, signal);
      const blocked = operatorPublicResultSchema.safeParse(raw);
      if (blocked.success) {
        throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
      }
      const value = bindingSchema.parse(raw);
      if (
        value.operationRef !== request.operationRef ||
        !sameOperatorSelection(request.selection, value.plan.selection) ||
        value.proof.releaseId !== value.plan.release.id ||
        value.proof.manifestSha256 !== value.plan.release.sha256
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return {
        ...value,
        environment: restrictedOperatorEnvironment(
          value.plan,
          value.environment,
          input.ownerContext?.authority,
        ),
      };
    },
    async neonAuthorization(
      request: Extract<OperatorRequest, { action: "neon-authorization" }>,
      signal?: AbortSignal,
    ) {
      try {
        const raw = await send(request, signal);
        const blocked = operatorPublicResultSchema.safeParse(raw);
        if (blocked.success) {
          throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
        }
        return neonAuthorizationResultSchema.parse(raw);
      } catch (error) {
        if (error instanceof HostedOperatorError) {
          throw error;
        }
        throw new HostedOperatorError("operator_unavailable");
      }
    },
    ownerContext: input.ownerContext,
    async request(
      request: Exclude<
        OperatorRequest,
        { action: "bindings" | "auth-identity-input" | "neon-authorization" }
      >,
      signal?: AbortSignal,
    ) {
      return operatorPublicResultSchema.parse(await send(request, signal));
    },
    sessionId: input.sessionId,
  };
};
export const hostedOperatorClientForSession = async (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Eve supplies unknown auth; exactForwardedSessionAuthority parses it at this boundary.
  sessionAuth: unknown,
  adapterSessionId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const report = createHostedOperatorConsentDiagnostic(adapterSessionId);
  let stage: HostedOperatorConsentMetadata["stage"] = "configuration";
  const emit = (outcome: HostedOperatorConsentMetadata["outcome"]) => {
    report({ boundary: "builder", outcome, phase: "inline", stage });
  };
  emit("started");
  try {
    const endpoint = environment.HOSTED_RUNTIME_OPERATOR_URL;
    if (endpoint === undefined || endpoint === "") {
      throw new HostedOperatorError("protected_operator_required");
    }
    emit("verified");
    stage = "owner_authority";
    emit("started");
    const { authority, principal } = exactForwardedSessionAuthority(sessionAuth);
    emit("verified");
    stage = "owner_context";
    emit("started");
    const ownerContext = await resolveHostedOperatorOwnerContext({
      adapterSessionId,
      authority,
      environment,
      principal,
      sessionAuth,
    });
    emit("verified");
    stage = "client_construction";
    emit("started");
    const client = createHostedOperatorClient({
      endpoint,
      ownerContext,
      sessionId: ownerContext.sessionId,
      token: createVercelWorkloadIdentity().token,
    });
    emit("verified");
    return client;
  } catch (error) {
    emit(
      error instanceof HostedOperatorError && error.code === "authorization_required"
        ? "operator_access_denied"
        : "setup_unavailable",
    );
    throw error;
  }
};
