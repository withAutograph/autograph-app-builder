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
) => {
  const owner = operator.ownerContext;
  if (owner === undefined || owner === null || operator.sessionId !== owner.sessionId) {
    throw new ConnectionAuthorizationFailedError(name, {
      reason: "owner_context_unavailable",
      retryable: false,
    });
  }
  const { sessionId } = owner;
  const assertPrincipal = (principal: ConnectionPrincipal) => {
    if (
      principal.type !== "user" ||
      principal.id !== owner.authority.ownerUserId ||
      principal.issuer !== owner.authority.issuer
    ) {
      throw new ConnectionAuthorizationFailedError(name, {
        reason: "principal_mismatch",
        retryable: false,
      });
    }
  };
  const read = async (phase: "check" | "complete") =>
    await operator.neonAuthorization(
      { action: "neon-authorization", phase, sessionId },
      ctx.abortSignal,
    );
  const ready = (expiresAt: number) => ({
    expiresAt,
    // This local readiness marker is used only by Eve's inline pause/resume API.
    // It carries no credential and must never be used in a provider request.
    token: `hosted-neon-ready:${owner.sessionId}:${owner.adapterGeneration}`,
  });
  const provider = defineInteractiveAuthorization({
    async completeAuthorization({ principal }) {
      assertPrincipal(principal);
      const result = await read("complete");
      if (result.status !== "ready") {
        throw new ConnectionAuthorizationFailedError(name, { reason: "authorization_incomplete" });
      }
      return ready(result.expiresAt);
    },
    async getToken({ principal }) {
      assertPrincipal(principal);
      const result = await read("check");
      if (result.status !== "ready") {
        throw new ConnectionAuthorizationRequiredError(name);
      }
      return ready(result.expiresAt);
    },
    async startAuthorization({ principal, callbackUrl }) {
      assertPrincipal(principal);
      const result = await operator.neonAuthorization(
        { action: "neon-authorization", callbackUrl, phase: "start", sessionId },
        ctx.abortSignal,
      );
      if (result.status !== "authorization-started") {
        throw new ConnectionAuthorizationFailedError(name, { reason: "authorization_unavailable" });
      }
      // Connect owns consent state and PKCE. No request/verifier is journaled by Eve.
      return { challenge: result.challenge };
    },
  });
  try {
    await ctx.getToken(provider, {
      authKey: `hosted-neon:${owner.sessionId}:${owner.adapterGeneration}`,
      displayName: "Connect Neon",
    });
  } catch (error) {
    if (error instanceof HostedOperatorError) {
      return error.code;
    }
    throw error;
  }
  return null;
};
