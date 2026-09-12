import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  hostedIdentifierSchema,
  hostedPrincipalSchema,
  type HostedPrincipal,
} from "../eve/hosted-auth";

const forwardedAttributesSchema = z
  .object({
    "mcp:audience": z.string().url().startsWith("https://"),
    "mcp:scopes": z.array(z.string().min(1).max(100)).min(1).max(50),
    "mcp:workspace-id": z.string().min(1).max(200),
    "eve:forwarded-by": hostedIdentifierSchema.optional(),
    "autograph:source-handoff-id": z.string().uuid().optional(),
  })
  .strict();

const forwardedHostedAuthSchema = z
  .object({
    attributes: forwardedAttributesSchema,
    authenticator: z.literal("mcp-oauth-jwks"),
    issuer: z.string().url().startsWith("https://"),
    principalId: z.string().min(1).max(200),
    principalType: z.literal("user"),
    subject: z.string().min(1).max(200),
  })
  .strict();

const forwardedSessionAuthSchema = z
  .object({
    current: forwardedHostedAuthSchema,
    initiator: forwardedHostedAuthSchema,
  })
  .strict();

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
 * used by every hosted side effect. Current and initiating users must match;
 * callers cannot adopt ambient workspace or owner identifiers.
 */
export function exactForwardedSessionAuthority(sessionAuth: unknown): {
  authority: HostedSessionTenantAuthority;
  principal: HostedPrincipal;
} {
  const parsed = forwardedSessionAuthSchema.safeParse(sessionAuth);
  if (!parsed.success) {
    throw new HostedSessionAuthorityError("invalid");
  }
  const { current, initiator } = parsed.data;
  function authorityInput(context: typeof current) {
    if (context.principalId !== context.subject) {
      throw new HostedSessionAuthorityError("subject");
    }
    return {
      issuer: context.issuer,
      audience: context.attributes["mcp:audience"],
      workspaceId: context.attributes["mcp:workspace-id"],
      ownerUserId: context.subject,
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
  if (!authorityResult.success || !currentPrincipal.success || !initiatorPrincipal.success)
    throw new HostedSessionAuthorityError("invalid");
  const authority = authorityResult.data;
  return { authority, principal: currentPrincipal.data };
}

/** A prepared app belongs to the initiating session, not a later message. */
export function sourceHandoffIdForSessionAuth(sessionAuth: unknown) {
  const parsed = forwardedSessionAuthSchema.safeParse(sessionAuth);
  if (!parsed.success) {
    // Local sessions have no prepared hosted context. A malformed hosted
    // envelope must not silently become an unbound session.
    const current = (sessionAuth as { current?: { authenticator?: string } } | null)?.current;
    if (current?.authenticator === "mcp-oauth-jwks")
      throw new HostedSessionAuthorityError("invalid");
    return undefined;
  }
  exactForwardedSessionAuthority(sessionAuth);
  const current = parsed.data.current.attributes["autograph:source-handoff-id"];
  const initiator = parsed.data.initiator.attributes["autograph:source-handoff-id"];
  if (current !== initiator) throw new HostedSessionAuthorityError("mismatch");
  return initiator;
}
