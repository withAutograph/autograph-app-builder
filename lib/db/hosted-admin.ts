import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedIdentifierSchema } from "../eve/hosted-auth";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const instantSchema = z.iso.datetime({ offset: true });

const hasCredentialsOrSuffix = (url: URL): boolean =>
  Boolean(url.username || url.password || url.search || url.hash);

export const hostedTenantAuthoritySchema = z
  .strictObject({
    audience: z.url().startsWith("https://"),
    issuer: z.url().startsWith("https://"),
    ownerUserId: hostedIdentifierSchema,
    workspaceId: hostedIdentifierSchema,
  })
  .superRefine((authority, context) => {
    const issuer = new URL(authority.issuer);
    const audience = new URL(authority.audience);
    if (hasCredentialsOrSuffix(issuer) || issuer.pathname !== "/api/auth") {
      context.addIssue({
        code: "custom",
        message: "Hosted Preview issuer must be the exact /api/auth URL.",
        path: ["issuer"],
      });
    }
    if (hasCredentialsOrSuffix(audience) || audience.pathname !== "/mcp") {
      context.addIssue({
        code: "custom",
        message: "Hosted Preview audience must be the exact /mcp URL.",
        path: ["audience"],
      });
    }
    if (issuer.origin !== audience.origin) {
      context.addIssue({
        code: "custom",
        message: "Hosted Preview issuer and audience must share one origin.",
        path: ["audience"],
      });
    }
  });

const membershipSeedAction = "membership.seed";
const membershipRevokeAction = "membership.revoke";
const retentionApplyAction = "retention.apply";
const tenantDeleteAction = "tenant.delete";

const requestBase = {
  authority: hostedTenantAuthoritySchema,
  requestedAt: instantSchema,
  version: z.literal(1),
};

const seedPlanSchema = z.strictObject({ ...requestBase, action: z.literal(membershipSeedAction) });
const revokePlanSchema = z.strictObject({
  ...requestBase,
  action: z.literal(membershipRevokeAction),
});
const retentionPlanSchema = z.strictObject({
  ...requestBase,
  action: z.literal(retentionApplyAction),
  deleteBefore: instantSchema,
});
const deletePlanSchema = z.strictObject({
  ...requestBase,
  action: z.literal(tenantDeleteAction),
  membershipRevokedBefore: instantSchema,
});

export const hostedAdminPlanRequestSchema = z.discriminatedUnion("action", [
  seedPlanSchema,
  revokePlanSchema,
  retentionPlanSchema,
  deletePlanSchema,
]);

export type HostedAdminPlanRequest = z.infer<typeof hostedAdminPlanRequestSchema>;

export const hostedAdminApplyRequestSchema = z.discriminatedUnion("action", [
  seedPlanSchema.extend({ confirmationDigest: sha256Schema }),
  revokePlanSchema.extend({ confirmationDigest: sha256Schema }),
  retentionPlanSchema.extend({ confirmationDigest: sha256Schema }),
  deletePlanSchema.extend({ confirmationDigest: sha256Schema }),
]);

export type HostedAdminApplyRequest = z.infer<typeof hostedAdminApplyRequestSchema>;

const effectsSchema = z.strictObject({
  authorizationStateRowsDeleted: z.number().int().min(0),
  integrationRowsDeleted: z.number().int().min(0),
  membershipRowsAffected: z.number().int().min(0),
  membershipRowsDeleted: z.number().int().min(0),
  operationRowsDeleted: z.number().int().min(0),
  sessionRowsDeleted: z.number().int().min(0),
});

export const hostedAdminReceiptSchema = z.strictObject({
  action: z.enum([
    membershipSeedAction,
    membershipRevokeAction,
    retentionApplyAction,
    tenantDeleteAction,
  ]),
  appliedAt: instantSchema,
  authorityDigest: sha256Schema,
  database: z.strictObject({
    dialect: z.literal("postgresql"),
    maxConnections: z.literal(1),
    secretTransport: z.literal("task-scoped-stdin"),
  }),
  effects: effectsSchema,
  requestDigest: sha256Schema,
  status: z.enum(["applied", "no-op"]),
  version: z.literal(1),
});

export type HostedAdminReceipt = z.infer<typeof hostedAdminReceiptSchema>;

export interface HostedAdminStore {
  seedMembership: (input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    now: Date;
  }) => Promise<{
    membershipRowsAffected: number;
  }>;
  revokeMembership: (input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    now: Date;
  }) => Promise<{
    membershipRowsAffected: number;
  }>;
  applyRetention: (input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    deleteBefore: Date;
  }) => Promise<{
    operationRowsDeleted: number;
    sessionRowsDeleted: number;
    integrationRowsDeleted?: number;
    authorizationStateRowsDeleted?: number;
  }>;
  deleteTenant: (input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    membershipRevokedBefore: Date;
  }) => Promise<{
    membershipRowsDeleted: number;
    operationRowsDeleted: number;
    sessionRowsDeleted: number;
    integrationRowsDeleted?: number;
    authorizationStateRowsDeleted?: number;
  }>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function canonicalRequest(request: HostedAdminPlanRequest): string {
  if (request.action === retentionApplyAction) {
    return JSON.stringify({
      action: request.action,
      authority: request.authority,
      deleteBefore: request.deleteBefore,
      requestedAt: request.requestedAt,
      version: request.version,
    });
  }
  if (request.action === tenantDeleteAction) {
    return JSON.stringify({
      action: request.action,
      authority: request.authority,
      membershipRevokedBefore: request.membershipRevokedBefore,
      requestedAt: request.requestedAt,
      version: request.version,
    });
  }
  return JSON.stringify({
    action: request.action,
    authority: request.authority,
    requestedAt: request.requestedAt,
    version: request.version,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface HostedAdminRetentionDigest {
  deleteBeforeDigest?: ReturnType<typeof digest>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function planHostedAdminRequest(input: unknown) {
  const request = hostedAdminPlanRequestSchema.parse(input);
  const plan = {
    action: request.action,
    authorityDigest: digest(JSON.stringify(request.authority)),
    requestDigest: digest(canonicalRequest(request)),
    requestedAt: request.requestedAt,
    requiredConfirmationDigest: digest(`confirm\n${canonicalRequest(request)}`),
    version: 1 as const,
  };
  const retention: HostedAdminRetentionDigest = {};
  if (request.action === retentionApplyAction) {
    retention.deleteBeforeDigest = digest(request.deleteBefore);
  }
  return { ...plan, ...retention };
}

const emptyEffects = {
  authorizationStateRowsDeleted: 0,
  integrationRowsDeleted: 0,
  membershipRowsAffected: 0,
  membershipRowsDeleted: 0,
  operationRowsDeleted: 0,
  sessionRowsDeleted: 0,
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function executeHostedAdminRequest(input: {
  request: unknown;
  store: HostedAdminStore;
  now?: () => number;
}): Promise<HostedAdminReceipt> {
  const request = hostedAdminApplyRequestSchema.parse(input.request);
  let planRequest: HostedAdminPlanRequest;
  if (request.action === retentionApplyAction) {
    planRequest = {
      action: request.action,
      authority: request.authority,
      deleteBefore: request.deleteBefore,
      requestedAt: request.requestedAt,
      version: request.version,
    };
  } else if (request.action === tenantDeleteAction) {
    planRequest = {
      action: request.action,
      authority: request.authority,
      membershipRevokedBefore: request.membershipRevokedBefore,
      requestedAt: request.requestedAt,
      version: request.version,
    };
  } else {
    planRequest = {
      action: request.action,
      authority: request.authority,
      requestedAt: request.requestedAt,
      version: request.version,
    };
  }
  const plan = planHostedAdminRequest(planRequest);
  if (request.confirmationDigest !== plan.requiredConfirmationDigest) {
    throw new Error("Hosted database action confirmation did not match.");
  }

  const nowEpochMs = input.now?.() ?? Date.now();
  const requestedAtEpochMs = Date.parse(request.requestedAt);
  if (requestedAtEpochMs > nowEpochMs + 30_000 || nowEpochMs - requestedAtEpochMs > 15 * 60_000) {
    throw new Error("Hosted database action plan is stale.");
  }
  if (
    request.action === retentionApplyAction &&
    Date.parse(request.deleteBefore) >= requestedAtEpochMs
  ) {
    throw new Error("Hosted retention cutoff must precede the plan.");
  }
  if (
    request.action === tenantDeleteAction &&
    Date.parse(request.membershipRevokedBefore) > requestedAtEpochMs - 5 * 60_000
  ) {
    throw new Error("Hosted tenant deletion requires a five-minute revocation drain.");
  }

  let effects = { ...emptyEffects };
  switch (request.action) {
    case membershipSeedAction: {
      const result = await input.store.seedMembership({
        authority: request.authority,
        now: new Date(nowEpochMs),
      });
      effects.membershipRowsAffected = result.membershipRowsAffected;
      break;
    }
    case membershipRevokeAction: {
      const result = await input.store.revokeMembership({
        authority: request.authority,
        now: new Date(nowEpochMs),
      });
      effects.membershipRowsAffected = result.membershipRowsAffected;
      break;
    }
    case retentionApplyAction: {
      const result = await input.store.applyRetention({
        authority: request.authority,
        deleteBefore: new Date(request.deleteBefore),
      });
      effects = { ...effects, ...result };
      break;
    }
    case tenantDeleteAction: {
      const result = await input.store.deleteTenant({
        authority: request.authority,
        membershipRevokedBefore: new Date(request.membershipRevokedBefore),
      });
      effects = { ...effects, ...result };
      break;
    }
    default: {
      throw new Error("Unsupported hosted admin action");
    }
  }

  const changed = Object.values(effects).some((count) => count > 0);
  return hostedAdminReceiptSchema.parse({
    action: request.action,
    appliedAt: new Date(nowEpochMs).toISOString(),
    authorityDigest: plan.authorityDigest,
    database: {
      dialect: "postgresql",
      maxConnections: 1,
      secretTransport: "task-scoped-stdin",
    },
    effects,
    requestDigest: plan.requestDigest,
    status: changed ? "applied" : "no-op",
    version: 1,
  });
}
