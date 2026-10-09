import { createHostedOperatorConsentDiagnostic } from "../provisioning/hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  HostedOperatorConsentMetadata,
} from "../provisioning/hosted-operator-consent-diagnostic";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import type { ConnectionPrincipal } from "eve/connections";
import type { ToolContext } from "eve/tools";
import type { createHostedOperatorClient } from "../provisioning/hosted-operator-client";

type Operator = Pick<
  ReturnType<typeof createHostedOperatorClient>,
  "neonAuthorization" | "ownerContext" | "sessionId"
>;
const name = "hosted-neon";

/** Inline Eve authorization parks the original public session. It never receives a provider bearer. */
export const authorizeHostedNeonForTool = async (
  ctx: Pick<ToolContext, "abortSignal" | "getToken">,
  operator: Operator,
  diagnosticSink?: HostedOperatorConsentDiagnosticSink,
) => {
  const report = createHostedOperatorConsentDiagnostic(operator.sessionId ?? "", diagnosticSink);
  const emit = (
    phase: HostedOperatorConsentMetadata["phase"],
    stage: HostedOperatorConsentMetadata["stage"],
    outcome: HostedOperatorConsentMetadata["outcome"],
  ) => {
    report({ boundary: "builder", outcome, phase, stage });
  };
  emit("inline", "owner_context", "started");
  const owner = operator.ownerContext;
  if (owner === undefined || owner === null || operator.sessionId !== owner.sessionId) {
    emit("inline", "owner_context", "operator_access_denied");
    throw new ConnectionAuthorizationFailedError(name, {
      reason: "owner_context_unavailable",
      retryable: false,
    });
  }
  emit("inline", "owner_context", "verified");
  const { sessionId } = owner;
  const assertPrincipal = (
    principal: ConnectionPrincipal,
    phase: "check" | "start" | "complete",
  ) => {
    emit(phase, "principal", "started");
    if (
      principal.type !== "user" ||
      principal.id !== owner.authority.ownerUserId ||
      principal.issuer !== owner.authority.issuer
    ) {
      emit(phase, "principal", "operator_access_denied");
      throw new ConnectionAuthorizationFailedError(name, {
        reason: "principal_mismatch",
        retryable: false,
      });
    }
    emit(phase, "principal", "verified");
  };
  const request = async (input: Parameters<Operator["neonAuthorization"]>[0]) => {
    emit(input.phase, "operator_request", "started");
    try {
      const result = await operator.neonAuthorization(input, ctx.abortSignal);
      const outcomes = {
        "authorization-required": "consent_required",
        "authorization-started": "challenge_started",
        ready: "ready",
      } as const;
      emit(input.phase, "operator_request", outcomes[result.status]);
      return result;
    } catch (error) {
      emit(
        input.phase,
        "operator_request",
        error instanceof HostedOperatorError && error.code === "authorization_required"
          ? "operator_access_denied"
          : "setup_unavailable",
      );
      throw error;
    }
  };
  const read = async (phase: "check" | "complete") =>
    await request({ action: "neon-authorization", phase, sessionId });
  const ready = (expiresAt: number) => ({
    expiresAt,
    // This local readiness marker is used only by Eve's inline pause/resume API.
    // It carries no credential and must never be used in a provider request.
    token: `hosted-neon-ready:${owner.sessionId}:${owner.adapterGeneration}`,
  });
  const provider = defineInteractiveAuthorization({
    async completeAuthorization({ principal }) {
      assertPrincipal(principal, "complete");
      const result = await read("complete");
      if (result.status !== "ready") {
        throw new ConnectionAuthorizationFailedError(name, { reason: "authorization_incomplete" });
      }
      return ready(result.expiresAt);
    },
    async getToken({ principal }) {
      assertPrincipal(principal, "check");
      const result = await read("check");
      if (result.status !== "ready") {
        throw new ConnectionAuthorizationRequiredError(name);
      }
      return ready(result.expiresAt);
    },
    async startAuthorization({ principal, callbackUrl }) {
      assertPrincipal(principal, "start");
      const result = await request({
        action: "neon-authorization",
        callbackUrl,
        phase: "start",
        sessionId,
      });
      if (result.status !== "authorization-started") {
        throw new ConnectionAuthorizationFailedError(name, { reason: "authorization_unavailable" });
      }
      // Connect owns consent state and PKCE. No request/verifier is journaled by Eve.
      return { challenge: result.challenge };
    },
  });
  emit("inline", "inline_token", "started");
  try {
    await ctx.getToken(provider, {
      authKey: `hosted-neon:${owner.sessionId}:${owner.adapterGeneration}`,
      displayName: "Connect Neon",
    });
  } catch (error) {
    if (error instanceof HostedOperatorError) {
      emit(
        "inline",
        "inline_token",
        error.code === "authorization_required" ? "operator_access_denied" : "setup_unavailable",
      );
      return error.code;
    }
    emit("inline", "inline_token", "control_flow_propagated");
    throw error;
  }
  emit("inline", "inline_token", "ready");
  return null;
};

/** Operator denial is not evidence that a provider challenge exists. */
export const hostedNeonBlockedGuidance = (code: HostedOperatorError["code"]) =>
  code === "authorization_required"
    ? "Operator access was denied. No new public provider authorization challenge was returned; resolve operator access/setup before retrying."
    : "The protected operator setup is unavailable. No new public provider authorization challenge was returned; resolve operator access/setup before retrying.";

export const hostedNeonBlockedResult = (code: HostedOperatorError["code"]) => ({
  code,
  guidance: hostedNeonBlockedGuidance(code),
  status: "blocked" as const,
});
