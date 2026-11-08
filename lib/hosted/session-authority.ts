import { z } from "zod";
import {
  readVerifiedRealmContinuationAuthority,
  realmContinuationPrincipal,
} from "./realm-continuation-authority";
import type { RealmContinuationVerificationOptions } from "./realm-continuation-authority";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedIdentifierSchema, hostedPrincipalSchema } from "../eve/hosted-auth";
import type { HostedPrincipal } from "../eve/hosted-auth";

const forwardedAttributesSchema = z.strictObject({
  "autograph:source-handoff-id": z.uuid().optional(),
  "eve:forwarded-by": hostedIdentifierSchema.optional(),
  "mcp:audience": z.url().startsWith("https://"),
  "mcp:scopes": z.array(z.string().min(1).max(100)).min(1).max(50),
  "mcp:workspace-id": z.string().min(1).max(200),
});

const forwardedHostedAuthSchema = z.strictObject({
  attributes: forwardedAttributesSchema,
  authenticator: z.literal("mcp-oauth-jwks"),
  issuer: z.url().startsWith("https://"),
  principalId: z.string().min(1).max(200),
  principalType: z.literal("user"),
  subject: z.string().min(1).max(200),
});

const forwardedSessionAuthSchema = z.strictObject({
  current: forwardedHostedAuthSchema,
  initiator: forwardedHostedAuthSchema,
});

export interface RealmContinuationSessionAuthorityOptions {
  realmContinuation: {
    adapterSessionId: string;
    verification?: RealmContinuationVerificationOptions;
  };
}

export type HostedSessionTenantAuthority = z.infer<typeof hostedTenantAuthoritySchema>;

export class HostedSessionAuthorityError extends Error {
  readonly code: "invalid" | "subject" | "mismatch";

  constructor(code: "invalid" | "subject" | "mismatch") {
    super("Hosted session authority is invalid.");
    this.code = code;
    this.name = "HostedSessionAuthorityError";
  }
}

/**
 * Converts Eve's exact forwarded auth envelope into the one tenant authority
 * used by every hosted side effect. Human current and initiating users must
 * match. The purpose-sealed Realm service continuation derives the same owner
 * from the pinned original initiator; it never adopts ambient owner identity.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function exactForwardedSessionAuthority(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  sessionAuth: unknown,
  continuationOptions?: RealmContinuationSessionAuthorityOptions,
): {
  authority: HostedSessionTenantAuthority;
  principal: HostedPrincipal;
} {
  let delegation;
  try {
    if (continuationOptions !== undefined) {
      delegation = readVerifiedRealmContinuationAuthority(
        sessionAuth,
        continuationOptions.realmContinuation.verification,
      );
      if (
        delegation !== undefined &&
        delegation.adapterSessionId !== continuationOptions.realmContinuation.adapterSessionId
      ) {
        throw new HostedSessionAuthorityError("mismatch");
      }
    }
  } catch {
    throw new HostedSessionAuthorityError("invalid");
  }
  if (delegation !== undefined) {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- Keep the declared return contract for all supported results.
    return { authority: delegation.authority, principal: realmContinuationPrincipal(delegation) };
  }
  const parsed = forwardedSessionAuthSchema.safeParse(sessionAuth);
  if (!parsed.success) {
    throw new HostedSessionAuthorityError("invalid");
  }
  const { current, initiator } = parsed.data;
  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function authorityInput(context: typeof current) {
    if (context.principalId !== context.subject) {
      throw new HostedSessionAuthorityError("subject");
    }
    return {
      audience: context.attributes["mcp:audience"],
      issuer: context.issuer,
      ownerUserId: context.subject,
      workspaceId: context.attributes["mcp:workspace-id"],
    };
  }

  const currentInput = authorityInput(current);
  const initiatorInput = authorityInput(initiator);
  if (JSON.stringify(currentInput) !== JSON.stringify(initiatorInput)) {
    throw new HostedSessionAuthorityError("mismatch");
  }
  const authorityResult = hostedTenantAuthoritySchema.safeParse(currentInput);
  const currentPrincipal = hostedPrincipalSchema.safeParse({
    ...currentInput,
    scopes: current.attributes["mcp:scopes"],
  });
  const initiatorPrincipal = hostedPrincipalSchema.safeParse({
    ...initiatorInput,
    scopes: initiator.attributes["mcp:scopes"],
  });
  if (!authorityResult.success || !currentPrincipal.success || !initiatorPrincipal.success) {
    throw new HostedSessionAuthorityError("invalid");
  }
  const authority = authorityResult.data;
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Keep the declared return contract for all supported results.
  return { authority, principal: currentPrincipal.data };
}

/** A prepared app belongs to the initiating session, not a later message. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function sourceHandoffIdForSessionAuth(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  sessionAuth: unknown,
  continuationOptions?: RealmContinuationSessionAuthorityOptions,
) {
  try {
    if (continuationOptions !== undefined) {
      const delegation = readVerifiedRealmContinuationAuthority(
        sessionAuth,
        continuationOptions.realmContinuation.verification,
      );
      if (delegation !== undefined) {
        exactForwardedSessionAuthority(sessionAuth, continuationOptions);
        return delegation.initiator.attributes["autograph:source-handoff-id"];
      }
    }
  } catch {
    throw new HostedSessionAuthorityError("invalid");
  }
  const parsed = forwardedSessionAuthSchema.safeParse(sessionAuth);
  if (!parsed.success) {
    // Local sessions have no prepared hosted context. A malformed hosted
    // envelope must not silently become an unbound session.
    const current = (
      sessionAuth as { current?: { authenticator?: string; principalType?: string } } | null
    )?.current;
    if (current?.authenticator === "mcp-oauth-jwks" || current?.principalType === "service") {
      throw new HostedSessionAuthorityError("invalid");
    }
    // oxlint-disable-next-line typescript/consistent-return -- Preserve the absent source handoff result.
    return;
  }
  exactForwardedSessionAuthority(sessionAuth);
  const current = parsed.data.current.attributes["autograph:source-handoff-id"];
  const initiator = parsed.data.initiator.attributes["autograph:source-handoff-id"];
  if (current !== initiator) {
    throw new HostedSessionAuthorityError("mismatch");
  }
  return initiator;
}
