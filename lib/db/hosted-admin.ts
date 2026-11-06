import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedIdentifierSchema } from "../eve/hosted-auth";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const instantSchema = z.iso.datetime({ offset: true });
const hostedUrlSchema = z.url({ protocol: /^https$/u });
const hostedAdminAction = {
  membershipRevoke: "membership.revoke",
  membershipSeed: "membership.seed",
  retentionApply: "retention.apply",
  tenantDelete: "tenant.delete",
} as const;
const issuerPath = "/api/auth";
const audiencePath = "/mcp";
const issuerUrlMessage = "Hosted Preview issuer must be the exact /api/auth URL.";
const audienceUrlMessage = "Hosted Preview audience must be the exact /mcp URL.";
const sharedOriginMessage = "Hosted Preview issuer and audience must share one origin.";
const hostedAdminActionsSchema = z.enum([
  hostedAdminAction.membershipRevoke,
  hostedAdminAction.membershipSeed,
  hostedAdminAction.retentionApply,
  hostedAdminAction.tenantDelete,
]);

export const hostedTenantAuthoritySchema = z
  .strictObject({
    audience: hostedUrlSchema,
    issuer: hostedUrlSchema,
    ownerUserId: hostedIdentifierSchema,
    workspaceId: hostedIdentifierSchema,
  })
  .superRefine((authority, context) => {
    const issuer = new URL(authority.issuer);
    const audience = new URL(authority.audience);
    const issuerHasCredentials = Boolean(issuer.username || issuer.password);
    const issuerHasQueryOrHash = Boolean(issuer.search || issuer.hash);
    if (issuerHasCredentials || issuerHasQueryOrHash || issuer.pathname !== issuerPath) {
      context.addIssue({
        code: "custom",
        message: issuerUrlMessage,
        path: ["issuer"],
      });
    }
    const audienceHasCredentials = Boolean(audience.username || audience.password);
    const audienceHasQueryOrHash = Boolean(audience.search || audience.hash);
    if (audienceHasCredentials || audienceHasQueryOrHash || audience.pathname !== audiencePath) {
      context.addIssue({
        code: "custom",
        message: audienceUrlMessage,
        path: ["audience"],
      });
    }
    if (issuer.origin !== audience.origin) {
      context.addIssue({
        code: "custom",
        message: sharedOriginMessage,
        path: ["audience"],
      });
    }
  });

const requestBase = {
  authority: hostedTenantAuthoritySchema,
  requestedAt: instantSchema,
  version: z.literal(1),
};

const seedPlanSchema = z.strictObject({
  ...requestBase,
  action: z.literal(hostedAdminAction.membershipSeed),
});
const revokePlanSchema = z.strictObject({
  ...requestBase,
  action: z.literal(hostedAdminAction.membershipRevoke),
});
const retentionPlanSchema = z.strictObject({
  ...requestBase,
  action: z.literal(hostedAdminAction.retentionApply),
  deleteBefore: instantSchema,
});
const deletePlanSchema = z.strictObject({
  ...requestBase,
  action: z.literal(hostedAdminAction.tenantDelete),
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
  z.strictObject({ ...seedPlanSchema.shape, confirmationDigest: sha256Schema }),
  z.strictObject({ ...revokePlanSchema.shape, confirmationDigest: sha256Schema }),
  z.strictObject({ ...retentionPlanSchema.shape, confirmationDigest: sha256Schema }),
  z.strictObject({ ...deletePlanSchema.shape, confirmationDigest: sha256Schema }),
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
  action: hostedAdminActionsSchema,
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
  if (request.action === hostedAdminAction.retentionApply) {
    return JSON.stringify({
      action: request.action,
      authority: request.authority,
      deleteBefore: request.deleteBefore,
      requestedAt: request.requestedAt,
      version: request.version,
    });
  }
  if (request.action === hostedAdminAction.tenantDelete) {
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function planHostedAdminRequest(request: HostedAdminPlanRequest) {
  let plan = {
    action: request.action,
    authorityDigest: digest(JSON.stringify(request.authority)),
    requestDigest: digest(canonicalRequest(request)),
    requestedAt: request.requestedAt,
    requiredConfirmationDigest: digest(`confirm\n${canonicalRequest(request)}`),
    version: 1 as const,
  };
  if (request.action === hostedAdminAction.retentionApply) {
    plan = { ...plan, deleteBeforeDigest: digest(request.deleteBefore) };
  }
  return plan;
}

export interface HostedAdminExecutionInput {
  request: HostedAdminApplyRequest;
  store: HostedAdminStore;
  now?: () => number;
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
export async function executeHostedAdminRequest(
  input: HostedAdminExecutionInput,
): Promise<HostedAdminReceipt> {
  const request = hostedAdminApplyRequestSchema.parse(input.request);
  let planRequest: HostedAdminPlanRequest;
  if (request.action === hostedAdminAction.retentionApply) {
    planRequest = {
      action: request.action,
      authority: request.authority,
      deleteBefore: request.deleteBefore,
      requestedAt: request.requestedAt,
      version: request.version,
    };
  } else if (request.action === hostedAdminAction.tenantDelete) {
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
    request.action === hostedAdminAction.retentionApply &&
    Date.parse(request.deleteBefore) >= requestedAtEpochMs
  ) {
    throw new Error("Hosted retention cutoff must precede the plan.");
  }
  if (
    request.action === hostedAdminAction.tenantDelete &&
    Date.parse(request.membershipRevokedBefore) > requestedAtEpochMs - 5 * 60_000
  ) {
    throw new Error("Hosted tenant deletion requires a five-minute revocation drain.");
  }

  let effects = { ...emptyEffects };
  switch (request.action) {
    case hostedAdminAction.membershipSeed: {
      const result = await input.store.seedMembership({
        authority: request.authority,
        now: new Date(nowEpochMs),
      });
      effects.membershipRowsAffected = result.membershipRowsAffected;
      break;
    }
    case hostedAdminAction.membershipRevoke: {
      const result = await input.store.revokeMembership({
        authority: request.authority,
        now: new Date(nowEpochMs),
      });
      effects.membershipRowsAffected = result.membershipRowsAffected;
      break;
    }
    case hostedAdminAction.retentionApply: {
      const result = await input.store.applyRetention({
        authority: request.authority,
        deleteBefore: new Date(request.deleteBefore),
      });
      effects = { ...effects, ...result };
      break;
    }
    case hostedAdminAction.tenantDelete: {
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
