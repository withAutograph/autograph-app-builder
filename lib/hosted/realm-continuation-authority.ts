import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedIdentifierSchema, hostedPrincipalSchema } from "../eve/hosted-auth";
import { readHostedForwarderSubject } from "../eve/hosted-forwarder";
import {
  decryptVersionedVercelToken,
  encryptVercelToken,
  readVercelTokenKeyringEnvironment,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";

const purpose = "autograph-realm-continuation-authority-v1";
export const realmContinuationAuthorityAttribute = "autograph:realm-continuation-authority";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(200);
export const realmContinuationInitiatorSchema = z.strictObject({
  attributes: z.strictObject({
    "autograph:source-handoff-id": z.uuid().optional(),
    "eve:forwarded-by": hostedIdentifierSchema.optional(),
    "mcp:audience": z.url().startsWith("https://"),
    "mcp:scopes": z.array(z.string().min(1).max(100)).min(1).max(50),
    "mcp:workspace-id": identifier,
  }),
  authenticator: z.literal("mcp-oauth-jwks"),
  issuer: z.url().startsWith("https://"),
  principalId: identifier,
  principalType: z.literal("user"),
  subject: identifier,
});
const serviceSchema = z.strictObject({
  authenticator: z.literal("autograph-realm-continuation"),
  forwardedBy: hostedIdentifierSchema,
  issuer: z.url().startsWith("https://"),
  principalId: hostedIdentifierSchema,
  subject: hostedIdentifierSchema,
});
const claimSchema = z.strictObject({
  adapterSessionId: identifier,
  appId: identifier,
  approvedPlanDigest: digest,
  authority: hostedTenantAuthoritySchema,
  initiator: realmContinuationInitiatorSchema,
  nonceSha256: digest,
  operationRef: z.uuid(),
  ownerSessionId: identifier,
  purpose: z.literal(purpose),
  reason: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("consumed-proof"),
      proofRef: z.string().min(1),
      proofSha256: digest,
    }),
    z.strictObject({
      kind: z.literal("expired-technical-wait"),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  ]),
  service: serviceSchema,
});
const sealedSchema = z.strictObject({
  encryptedToken: z.string().min(1),
  keyVersion: z.string().min(1),
  tokenIv: z.string().min(1),
  tokenTag: z.string().min(1),
});
export type RealmContinuationAuthority = z.infer<typeof claimSchema>;
export type RealmContinuationReason = RealmContinuationAuthority["reason"];
export type RealmContinuationServiceIdentity = z.infer<typeof serviceSchema>;
export interface RealmContinuationVerificationOptions {
  config: VercelTokenKeyringConfig;
  service: RealmContinuationServiceIdentity;
}
export class RealmContinuationAuthorityError extends Error {
  constructor() {
    super("Realm continuation authority is invalid.");
    this.name = "RealmContinuationAuthorityError";
  }
}

export const realmContinuationServiceIdentityForWorkload = (input: {
  issuer: string;
  subject: string;
}): RealmContinuationServiceIdentity =>
  serviceSchema.parse({
    authenticator: "autograph-realm-continuation",
    forwardedBy: input.subject,
    issuer: input.issuer,
    principalId: `${input.issuer}:${input.subject}`,
    subject: input.subject,
  });

/** Exact project service projection; never replaces the pinned human initiator. */
export const readRealmContinuationServiceIdentity = (
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RealmContinuationServiceIdentity => {
  const subject = readHostedForwarderSubject(environment);
  if (subject === undefined) {
    throw new RealmContinuationAuthorityError();
  }
  const issuer = `https://oidc.vercel.com/${environment.EVE_HOSTED_VERCEL_TEAM_SLUG}`;
  return realmContinuationServiceIdentityForWorkload({ issuer, subject });
};
const optionsFor = (options?: RealmContinuationVerificationOptions) =>
  options ?? {
    config: readVercelTokenKeyringEnvironment(process.env),
    service: readRealmContinuationServiceIdentity(),
  };
const principalFor = (initiator: RealmContinuationAuthority["initiator"]) => {
  if (initiator.principalId !== initiator.subject) {
    throw new RealmContinuationAuthorityError();
  }
  return hostedPrincipalSchema.parse({
    audience: initiator.attributes["mcp:audience"],
    issuer: initiator.issuer,
    ownerUserId: initiator.subject,
    scopes: initiator.attributes["mcp:scopes"],
    workspaceId: initiator.attributes["mcp:workspace-id"],
  });
};
const sameInitiator = (
  left: RealmContinuationAuthority["initiator"],
  right: RealmContinuationAuthority["initiator"],
) =>
  JSON.stringify([
    left.authenticator,
    left.issuer,
    left.principalType,
    left.principalId,
    left.subject,
    left.attributes["mcp:audience"],
    left.attributes["mcp:workspace-id"],
    [...left.attributes["mcp:scopes"]].toSorted(),
    left.attributes["autograph:source-handoff-id"],
    left.attributes["eve:forwarded-by"],
  ]) ===
  JSON.stringify([
    right.authenticator,
    right.issuer,
    right.principalType,
    right.principalId,
    right.subject,
    right.attributes["mcp:audience"],
    right.attributes["mcp:workspace-id"],
    [...right.attributes["mcp:scopes"]].toSorted(),
    right.attributes["autograph:source-handoff-id"],
    right.attributes["eve:forwarded-by"],
  ]);
const validateClaim = (claim: RealmContinuationAuthority) => {
  const { scopes, ...authority } = principalFor(claim.initiator);
  void scopes;
  for (const key of ["issuer", "audience", "ownerUserId", "workspaceId"] as const) {
    if (authority[key] !== claim.authority[key]) {
      throw new RealmContinuationAuthorityError();
    }
  }
  return claim;
};

/** Caller must obtain these observations independently from protected owner records. */
export const mintRealmContinuationAuthority = (input: {
  config: VercelTokenKeyringConfig;
  observed: Omit<RealmContinuationAuthority, "purpose" | "service">;
  service: RealmContinuationServiceIdentity;
}): string => {
  try {
    const claim = validateClaim(
      claimSchema.parse({
        ...input.observed,
        purpose,
        service: input.service,
      }),
    );
    return JSON.stringify({
      ...encryptVercelToken({
        associatedData: purpose,
        key: input.config.tokenKey,
        token: JSON.stringify(claim),
      }),
      keyVersion: input.config.tokenKeyVersion,
    });
  } catch {
    throw new RealmContinuationAuthorityError();
  }
};

/** Private operator boundary: preserve and reverify the opaque restriction across service calls. */
export const readSealedRealmContinuationAuthority = (
  sealedAuthority: string,
  options?: RealmContinuationVerificationOptions,
): RealmContinuationAuthority => {
  try {
    const { config, service } = optionsFor(options);
    const sealed = sealedSchema.parse(JSON.parse(sealedAuthority));
    const claim = validateClaim(
      claimSchema.parse(
        JSON.parse(
          decryptVersionedVercelToken({
            ...sealed,
            associatedData: purpose,
            config,
          }),
        ),
      ),
    );
    for (const key of [
      "authenticator",
      "issuer",
      "principalId",
      "subject",
      "forwardedBy",
    ] as const) {
      if (claim.service[key] !== service[key]) {
        throw new RealmContinuationAuthorityError();
      }
    }
    return claim;
  } catch {
    throw new RealmContinuationAuthorityError();
  }
};

/** Private native auth only: never include this envelope in model or public content. */
export const readVerifiedRealmContinuationAuthority = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser is the private native session auth boundary.
  sessionAuth: unknown,
  options?: RealmContinuationVerificationOptions,
): RealmContinuationAuthority | undefined => {
  const candidate = z
    .object({
      current: z
        .object({
          principalType: z.string().optional(),
          attributes: z
            .object({ [realmContinuationAuthorityAttribute]: z.unknown().optional() })
            .optional(),
        })
        .optional(),
    })
    .safeParse(sessionAuth);
  const current = candidate.success ? candidate.data.current : undefined;
  if (
    current?.attributes?.[realmContinuationAuthorityAttribute] === undefined &&
    current?.principalType !== "service"
  ) {
    return undefined;
  }
  try {
    const config = optionsFor(options);
    const parsed = z
      .strictObject({
        current: z.strictObject({
          attributes: z.strictObject({
            "eve:forwarded-by": hostedIdentifierSchema,
            [realmContinuationAuthorityAttribute]: z.string().min(1),
          }),
          authenticator: serviceSchema.shape.authenticator,
          issuer: serviceSchema.shape.issuer,
          principalId: serviceSchema.shape.principalId,
          principalType: z.literal("service"),
          subject: serviceSchema.shape.subject,
        }),
        initiator: realmContinuationInitiatorSchema,
      })
      .parse(sessionAuth);
    const claim = readSealedRealmContinuationAuthority(
      parsed.current.attributes[realmContinuationAuthorityAttribute],
      config,
    );
    for (const key of ["authenticator", "issuer", "principalId", "subject"] as const) {
      if (
        parsed.current[key] !== config.service[key] ||
        claim.service[key] !== config.service[key]
      ) {
        throw new RealmContinuationAuthorityError();
      }
    }
    if (
      parsed.current.attributes["eve:forwarded-by"] !== config.service.forwardedBy ||
      claim.service.forwardedBy !== config.service.forwardedBy ||
      !sameInitiator(claim.initiator, parsed.initiator)
    ) {
      throw new RealmContinuationAuthorityError();
    }
    return claim;
  } catch {
    throw new RealmContinuationAuthorityError();
  }
};

export const createRealmContinuationServiceAuth = (
  input: RealmContinuationVerificationOptions & {
    claim: string;
    initiator: RealmContinuationAuthority["initiator"];
  },
) => {
  const { forwardedBy, ...service } = input.service;
  const auth = {
    current: {
      ...service,
      attributes: {
        "eve:forwarded-by": forwardedBy,
        [realmContinuationAuthorityAttribute]: input.claim,
      },
      principalType: "service" as const,
    },
    initiator: input.initiator,
  };
  readVerifiedRealmContinuationAuthority(auth, input);
  return auth;
};

export const realmContinuationPrincipal = (claim: RealmContinuationAuthority) =>
  principalFor(claim.initiator);
