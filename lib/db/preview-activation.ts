import { createHash } from "node:crypto";

import { z } from "zod";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const instantSchema = z.string().datetime({ offset: true });
const httpsUrlSchema = z.string().url().startsWith("https://");
const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const roleSchema = z.string().regex(/^[a-z][a-z0-9_]{2,62}$/u);
const passwordSchema = z
  .string()
  .min(12)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value));

const common = {
  version: z.literal(1),
  requestedAt: instantSchema,
};

const invitedUserSchema = z
  .object({
    ...common,
    action: z.literal("invited-user.provision"),
    issuer: httpsUrlSchema,
    resource: httpsUrlSchema,
    userId: identifierSchema,
    workspaceId: identifierSchema,
    email: z
      .string()
      .email()
      .transform((value) => value.toLowerCase()),
    name: z.string().trim().min(1).max(128),
    password: passwordSchema,
  })
  .strict();

const runtimeRoleSchema = z
  .object({
    ...common,
    action: z.literal("runtime-role.configure"),
    roleName: roleSchema,
    password: passwordSchema,
  })
  .strict();

const oauthInitializeSchema = z
  .object({
    ...common,
    action: z.literal("oauth.initialize"),
    issuer: httpsUrlSchema,
    resource: httpsUrlSchema,
    authSecret: z
      .string()
      .min(32)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
  })
  .strict();

export const previewActivationPlanRequestSchema = z
  .discriminatedUnion("action", [
    invitedUserSchema,
    runtimeRoleSchema,
    oauthInitializeSchema,
  ])
  .superRefine((request, context) => {
    if (request.action === "runtime-role.configure") return;
    const issuer = new URL(request.issuer);
    const resource = new URL(request.resource);
    if (
      issuer.pathname !== "/api/auth" ||
      issuer.search ||
      issuer.hash ||
      resource.pathname !== "/mcp" ||
      resource.search ||
      resource.hash ||
      issuer.origin !== resource.origin
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Preview activation requires one same-origin /api/auth and /mcp pair.",
      });
    }
  });

export type PreviewActivationPlanRequest = z.infer<
  typeof previewActivationPlanRequestSchema
>;

export const previewActivationApplyRequestSchema = z.union([
  invitedUserSchema.extend({ confirmationDigest: sha256Schema }).strict(),
  runtimeRoleSchema.extend({ confirmationDigest: sha256Schema }).strict(),
  oauthInitializeSchema.extend({ confirmationDigest: sha256Schema }).strict(),
]);

const effectsSchema = z
  .object({
    userRowsAffected: z.number().int().min(0).max(1),
    accountRowsAffected: z.number().int().min(0).max(1),
    membershipRowsAffected: z.number().int().min(0).max(1),
    resourceRowsBefore: z.number().int().min(0).max(1),
    resourceRowsAfter: z.number().int().min(0).max(1),
    jwksRowsBefore: z.number().int().min(0).max(100),
    jwksRowsAfter: z.number().int().min(0).max(100),
    runtimeRoleCreated: z.boolean(),
    runtimeRoleLogin: z.boolean(),
    runtimeRoleCanConnect: z.boolean(),
    runtimeRoleCanUseSchema: z.boolean(),
    runtimeRoleCanCreateSchemaObjects: z.literal(false),
    runtimeRoleTablePrivilegesExact: z.boolean(),
    runtimeRoleSequencePrivilegesExact: z.boolean(),
    runtimeRoleAttributesExact: z.boolean(),
    runtimeRoleMembershipCount: z.literal(0),
  })
  .strict();

export const previewActivationReceiptSchema = z
  .object({
    version: z.literal(1),
    action: z.enum([
      "invited-user.provision",
      "runtime-role.configure",
      "oauth.initialize",
    ]),
    status: z.enum(["applied", "no-op"]),
    requestDigest: sha256Schema,
    authorityDigest: sha256Schema,
    appliedAt: instantSchema,
    effects: effectsSchema,
    database: z
      .object({
        dialect: z.literal("postgresql"),
        secretTransport: z.literal("owner-only-request-and-task-scoped-stdin"),
        maxConnections: z.literal(1),
      })
      .strict(),
  })
  .strict();

export type PreviewActivationReceipt = z.infer<
  typeof previewActivationReceiptSchema
>;

export interface PreviewActivationStore {
  provisionInvitedUser(
    input: Extract<
      PreviewActivationPlanRequest,
      { action: "invited-user.provision" }
    >,
  ): Promise<
    Pick<
      z.infer<typeof effectsSchema>,
      "userRowsAffected" | "accountRowsAffected" | "membershipRowsAffected"
    >
  >;
  configureRuntimeRole(
    input: Extract<
      PreviewActivationPlanRequest,
      { action: "runtime-role.configure" }
    >,
  ): Promise<
    Pick<
      z.infer<typeof effectsSchema>,
      | "runtimeRoleCreated"
      | "runtimeRoleLogin"
      | "runtimeRoleCanConnect"
      | "runtimeRoleCanUseSchema"
      | "runtimeRoleCanCreateSchemaObjects"
      | "runtimeRoleTablePrivilegesExact"
      | "runtimeRoleSequencePrivilegesExact"
      | "runtimeRoleAttributesExact"
      | "runtimeRoleMembershipCount"
    >
  >;
  initializeOAuth(
    input: Extract<
      PreviewActivationPlanRequest,
      { action: "oauth.initialize" }
    >,
  ): Promise<
    Pick<
      z.infer<typeof effectsSchema>,
      | "resourceRowsBefore"
      | "resourceRowsAfter"
      | "jwksRowsBefore"
      | "jwksRowsAfter"
    >
  >;
}

function canonicalRequest(request: PreviewActivationPlanRequest) {
  const secretDigest =
    request.action === "oauth.initialize"
      ? digest(request.authSecret)
      : digest(request.password);
  return JSON.stringify({
    ...request,
    ...(request.action === "oauth.initialize"
      ? { authSecret: secretDigest }
      : { password: secretDigest }),
  });
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function planPreviewActivation(input: unknown) {
  const request = previewActivationPlanRequestSchema.parse(input);
  const canonical = canonicalRequest(request);
  const authority =
    request.action === "runtime-role.configure"
      ? { roleName: request.roleName }
      : request.action === "oauth.initialize"
        ? { issuer: request.issuer, resource: request.resource }
        : {
            issuer: request.issuer,
            resource: request.resource,
            userId: request.userId,
            workspaceId: request.workspaceId,
            email: request.email,
          };
  return {
    version: 1 as const,
    action: request.action,
    requestDigest: digest(canonical),
    authorityDigest: digest(JSON.stringify(authority)),
    requiredConfirmationDigest: digest(`confirm\n${canonical}`),
    requestedAt: request.requestedAt,
  };
}

const emptyEffects: z.infer<typeof effectsSchema> = {
  userRowsAffected: 0,
  accountRowsAffected: 0,
  membershipRowsAffected: 0,
  resourceRowsBefore: 0,
  resourceRowsAfter: 0,
  jwksRowsBefore: 0,
  jwksRowsAfter: 0,
  runtimeRoleCreated: false,
  runtimeRoleLogin: false,
  runtimeRoleCanConnect: false,
  runtimeRoleCanUseSchema: false,
  runtimeRoleCanCreateSchemaObjects: false,
  runtimeRoleTablePrivilegesExact: false,
  runtimeRoleSequencePrivilegesExact: false,
  runtimeRoleAttributesExact: false,
  runtimeRoleMembershipCount: 0,
};

export const runtimeRoleReadbackSchema = z
  .object({
    canConnect: z.literal(true),
    canUseSchema: z.literal(true),
    canCreateSchemaObjects: z.literal(false),
    tablePrivilegesExact: z.literal(true),
    sequencePrivilegesExact: z.literal(true),
    canLogin: z.literal(true),
    inherits: z.literal(false),
    superuser: z.literal(false),
    createDatabase: z.literal(false),
    createRole: z.literal(false),
    replication: z.literal(false),
    bypassRls: z.literal(false),
    membershipCount: z.literal(0),
  })
  .strict();

export function assertRuntimeRoleReadback(input: unknown) {
  return runtimeRoleReadbackSchema.parse(input);
}

export async function executePreviewActivation(input: {
  request: unknown;
  store: PreviewActivationStore;
  now?: () => number;
}): Promise<PreviewActivationReceipt> {
  const apply = previewActivationApplyRequestSchema.parse(input.request);
  const planInput = Object.fromEntries(
    Object.entries(apply).filter(([key]) => key !== "confirmationDigest"),
  );
  const request = previewActivationPlanRequestSchema.parse(planInput);
  const plan = planPreviewActivation(request);
  if (apply.confirmationDigest !== plan.requiredConfirmationDigest) {
    throw new Error("Preview activation confirmation did not match.");
  }
  const nowEpochMs = input.now?.() ?? Date.now();
  const requestedAt = Date.parse(request.requestedAt);
  if (
    requestedAt > nowEpochMs + 30_000 ||
    nowEpochMs - requestedAt > 15 * 60_000
  ) {
    throw new Error("Preview activation request is stale.");
  }
  let effects = { ...emptyEffects };
  if (request.action === "invited-user.provision") {
    effects = {
      ...effects,
      ...(await input.store.provisionInvitedUser(request)),
    };
  } else if (request.action === "runtime-role.configure") {
    effects = {
      ...effects,
      ...(await input.store.configureRuntimeRole(request)),
    };
  } else {
    effects = { ...effects, ...(await input.store.initializeOAuth(request)) };
  }
  const changed =
    effects.userRowsAffected +
      effects.accountRowsAffected +
      effects.membershipRowsAffected >
      0 ||
    request.action === "runtime-role.configure" ||
    effects.runtimeRoleCreated ||
    effects.resourceRowsAfter > effects.resourceRowsBefore ||
    effects.jwksRowsAfter > effects.jwksRowsBefore;
  return previewActivationReceiptSchema.parse({
    version: 1,
    action: request.action,
    status: changed ? "applied" : "no-op",
    requestDigest: plan.requestDigest,
    authorityDigest: plan.authorityDigest,
    appliedAt: new Date(nowEpochMs).toISOString(),
    effects,
    database: {
      dialect: "postgresql",
      secretTransport: "owner-only-request-and-task-scoped-stdin",
      maxConnections: 1,
    },
  });
}
