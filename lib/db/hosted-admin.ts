import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedIdentifierSchema } from "../eve/hosted-auth";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const instantSchema = z.string().datetime({ offset: true });

export const hostedTenantAuthoritySchema = z
  .object({
    issuer: z.string().url().startsWith("https://"),
    audience: z.string().url().startsWith("https://"),
    workspaceId: hostedIdentifierSchema,
    ownerUserId: hostedIdentifierSchema,
  })
  .strict()
  .superRefine((authority, context) => {
    const issuer = new URL(authority.issuer);
    const audience = new URL(authority.audience);
    if (
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      issuer.pathname !== "/api/auth"
    ) {
      context.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "Hosted Preview issuer must be the exact /api/auth URL.",
      });
    }
    if (
      audience.username ||
      audience.password ||
      audience.search ||
      audience.hash ||
      audience.pathname !== "/mcp"
    ) {
      context.addIssue({
        code: "custom",
        path: ["audience"],
        message: "Hosted Preview audience must be the exact /mcp URL.",
      });
    }
    if (issuer.origin !== audience.origin) {
      context.addIssue({
        code: "custom",
        path: ["audience"],
        message: "Hosted Preview issuer and audience must share one origin.",
      });
    }
  });

const requestBase = {
  version: z.literal(1),
  authority: hostedTenantAuthoritySchema,
  requestedAt: instantSchema,
};

const seedPlanSchema = z
  .object({ ...requestBase, action: z.literal("membership.seed") })
  .strict();
const revokePlanSchema = z
  .object({ ...requestBase, action: z.literal("membership.revoke") })
  .strict();
const retentionPlanSchema = z
  .object({
    ...requestBase,
    action: z.literal("retention.apply"),
    deleteBefore: instantSchema,
  })
  .strict();
const deletePlanSchema = z
  .object({
    ...requestBase,
    action: z.literal("tenant.delete"),
    membershipRevokedBefore: instantSchema,
  })
  .strict();

export const hostedAdminPlanRequestSchema = z.discriminatedUnion("action", [
  seedPlanSchema,
  revokePlanSchema,
  retentionPlanSchema,
  deletePlanSchema,
]);

export type HostedAdminPlanRequest = z.infer<
  typeof hostedAdminPlanRequestSchema
>;

export const hostedAdminApplyRequestSchema = z.discriminatedUnion("action", [
  seedPlanSchema.extend({ confirmationDigest: sha256Schema }).strict(),
  revokePlanSchema.extend({ confirmationDigest: sha256Schema }).strict(),
  retentionPlanSchema.extend({ confirmationDigest: sha256Schema }).strict(),
  deletePlanSchema.extend({ confirmationDigest: sha256Schema }).strict(),
]);

export type HostedAdminApplyRequest = z.infer<
  typeof hostedAdminApplyRequestSchema
>;

const effectsSchema = z
  .object({
    membershipRowsAffected: z.number().int().min(0),
    membershipRowsDeleted: z.number().int().min(0),
    operationRowsDeleted: z.number().int().min(0),
    sessionRowsDeleted: z.number().int().min(0),
    integrationRowsDeleted: z.number().int().min(0),
    authorizationStateRowsDeleted: z.number().int().min(0),
  })
  .strict();

export const hostedAdminReceiptSchema = z
  .object({
    version: z.literal(1),
    action: z.enum([
      "membership.seed",
      "membership.revoke",
      "retention.apply",
      "tenant.delete",
    ]),
    status: z.enum(["applied", "no-op"]),
    requestDigest: sha256Schema,
    authorityDigest: sha256Schema,
    appliedAt: instantSchema,
    effects: effectsSchema,
    database: z
      .object({
        dialect: z.literal("postgresql"),
        secretTransport: z.literal("task-scoped-stdin"),
        maxConnections: z.literal(1),
      })
      .strict(),
  })
  .strict();

export type HostedAdminReceipt = z.infer<typeof hostedAdminReceiptSchema>;

export interface HostedAdminStore {
  seedMembership(input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    now: Date;
  }): Promise<{ membershipRowsAffected: number }>;
  revokeMembership(input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    now: Date;
  }): Promise<{ membershipRowsAffected: number }>;
  applyRetention(input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    deleteBefore: Date;
  }): Promise<{
    operationRowsDeleted: number;
    sessionRowsDeleted: number;
    integrationRowsDeleted?: number;
    authorizationStateRowsDeleted?: number;
  }>;
  deleteTenant(input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    membershipRevokedBefore: Date;
  }): Promise<{
    membershipRowsDeleted: number;
    operationRowsDeleted: number;
    sessionRowsDeleted: number;
    integrationRowsDeleted?: number;
    authorizationStateRowsDeleted?: number;
  }>;
}

function canonicalRequest(request: HostedAdminPlanRequest): string {
  return JSON.stringify(
    request.action === "retention.apply"
      ? {
          version: request.version,
          action: request.action,
          authority: request.authority,
          requestedAt: request.requestedAt,
          deleteBefore: request.deleteBefore,
        }
      : request.action === "tenant.delete"
        ? {
            version: request.version,
            action: request.action,
            authority: request.authority,
            requestedAt: request.requestedAt,
            membershipRevokedBefore: request.membershipRevokedBefore,
          }
        : {
            version: request.version,
            action: request.action,
            authority: request.authority,
            requestedAt: request.requestedAt,
          },
  );
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function planHostedAdminRequest(input: unknown) {
  const request = hostedAdminPlanRequestSchema.parse(input);
  return {
    version: 1 as const,
    action: request.action,
    requestDigest: digest(canonicalRequest(request)),
    authorityDigest: digest(JSON.stringify(request.authority)),
    requiredConfirmationDigest: digest(`confirm\n${canonicalRequest(request)}`),
    requestedAt: request.requestedAt,
    ...(request.action === "retention.apply"
      ? { deleteBeforeDigest: digest(request.deleteBefore) }
      : {}),
  };
}

const emptyEffects = {
  membershipRowsAffected: 0,
  membershipRowsDeleted: 0,
  operationRowsDeleted: 0,
  sessionRowsDeleted: 0,
  integrationRowsDeleted: 0,
  authorizationStateRowsDeleted: 0,
};

export async function executeHostedAdminRequest(input: {
  request: unknown;
  store: HostedAdminStore;
  now?: () => number;
}): Promise<HostedAdminReceipt> {
  const request = hostedAdminApplyRequestSchema.parse(input.request);
  const planRequest: HostedAdminPlanRequest =
    request.action === "retention.apply"
      ? {
          version: request.version,
          action: request.action,
          authority: request.authority,
          requestedAt: request.requestedAt,
          deleteBefore: request.deleteBefore,
        }
      : request.action === "tenant.delete"
        ? {
            version: request.version,
            action: request.action,
            authority: request.authority,
            requestedAt: request.requestedAt,
            membershipRevokedBefore: request.membershipRevokedBefore,
          }
        : {
            version: request.version,
            action: request.action,
            authority: request.authority,
            requestedAt: request.requestedAt,
          };
  const plan = planHostedAdminRequest(planRequest);
  if (request.confirmationDigest !== plan.requiredConfirmationDigest) {
    throw new Error("Hosted database action confirmation did not match.");
  }

  const nowEpochMs = input.now?.() ?? Date.now();
  const requestedAtEpochMs = Date.parse(request.requestedAt);
  if (
    requestedAtEpochMs > nowEpochMs + 30_000 ||
    nowEpochMs - requestedAtEpochMs > 15 * 60_000
  ) {
    throw new Error("Hosted database action plan is stale.");
  }
  if (
    request.action === "retention.apply" &&
    Date.parse(request.deleteBefore) >= requestedAtEpochMs
  ) {
    throw new Error("Hosted retention cutoff must precede the plan.");
  }
  if (
    request.action === "tenant.delete" &&
    Date.parse(request.membershipRevokedBefore) >
      requestedAtEpochMs - 5 * 60_000
  ) {
    throw new Error(
      "Hosted tenant deletion requires a five-minute revocation drain.",
    );
  }

  let effects = { ...emptyEffects };
  switch (request.action) {
    case "membership.seed": {
      const result = await input.store.seedMembership({
        authority: request.authority,
        now: new Date(nowEpochMs),
      });
      effects.membershipRowsAffected = result.membershipRowsAffected;
      break;
    }
    case "membership.revoke": {
      const result = await input.store.revokeMembership({
        authority: request.authority,
        now: new Date(nowEpochMs),
      });
      effects.membershipRowsAffected = result.membershipRowsAffected;
      break;
    }
    case "retention.apply": {
      const result = await input.store.applyRetention({
        authority: request.authority,
        deleteBefore: new Date(request.deleteBefore),
      });
      effects = { ...effects, ...result };
      break;
    }
    case "tenant.delete": {
      const result = await input.store.deleteTenant({
        authority: request.authority,
        membershipRevokedBefore: new Date(request.membershipRevokedBefore),
      });
      effects = { ...effects, ...result };
      break;
    }
  }

  const changed = Object.values(effects).some((count) => count > 0);
  return hostedAdminReceiptSchema.parse({
    version: 1,
    action: request.action,
    status: changed ? "applied" : "no-op",
    requestDigest: plan.requestDigest,
    authorityDigest: plan.authorityDigest,
    appliedAt: new Date(nowEpochMs).toISOString(),
    effects,
    database: {
      dialect: "postgresql",
      secretTransport: "task-scoped-stdin",
      maxConnections: 1,
    },
  });
}
