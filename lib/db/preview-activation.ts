import { createHash } from "node:crypto";

import { z } from "zod";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const instantSchema = z.string().datetime({ offset: true });
const httpsUrlSchema = z.string().url().startsWith("https://");
const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const roleSchema = z.string().regex(/^[a-z][a-z0-9_]{2,62}$/u);
const githubAccountIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const githubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u);
const passwordSchema = z
  .string()
  .min(12)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value));

const common = {
  requestedAt: instantSchema,
  version: z.literal(1),
};

const invitedUserSchema = z
  .object({
    ...common,
    action: z.literal("invited-user.provision"),
    email: z
      .string()
      .email()
      .transform((value) => value.toLowerCase()),
    githubAccountId: githubAccountIdSchema,
    githubLogin: githubLoginSchema,
    issuer: httpsUrlSchema,
    resource: httpsUrlSchema,
    userId: identifierSchema,
    workspaceId: identifierSchema,
  })
  .strict();

const runtimeRoleSchema = z
  .object({
    ...common,
    action: z.literal("runtime-role.configure"),
    password: passwordSchema,
    roleName: roleSchema,
  })
  .strict();

const oauthInitializeSchema = z
  .object({
    ...common,
    action: z.literal("oauth.initialize"),
    authSecret: z
      .string()
      .min(32)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    issuer: httpsUrlSchema,
    resource: httpsUrlSchema,
  })
  .strict();

export const previewActivationPlanRequestSchema = z
  .discriminatedUnion("action", [
    invitedUserSchema,
    runtimeRoleSchema,
    oauthInitializeSchema,
  ])
  .superRefine((request, context) => {
    if (request.action === "runtime-role.configure") {
      return;
    }
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
    accountRowsAffected: z.number().int().min(0).max(1),
    jwksRowsAfter: z.number().int().min(0).max(100),
    jwksRowsBefore: z.number().int().min(0).max(100),
    membershipRowsAffected: z.number().int().min(0).max(1),
    resourceRowsAfter: z.number().int().min(0).max(1),
    resourceRowsBefore: z.number().int().min(0).max(1),
    runtimeRoleAttributesExact: z.boolean(),
    runtimeRoleCanConnect: z.boolean(),
    runtimeRoleCanCreateSchemaObjects: z.literal(false),
    runtimeRoleCanUseSchema: z.boolean(),
    runtimeRoleCreated: z.boolean(),
    runtimeRoleLogin: z.boolean(),
    runtimeRoleMembershipCount: z.literal(0),
    runtimeRoleSequencePrivilegesExact: z.boolean(),
    runtimeRoleTablePrivilegesExact: z.boolean(),
    userRowsAffected: z.number().int().min(0).max(1),
  })
  .strict();

export const previewActivationReceiptSchema = z
  .object({
    action: z.enum([
      "invited-user.provision",
      "runtime-role.configure",
      "oauth.initialize",
    ]),
    appliedAt: instantSchema,
    authorityDigest: sha256Schema,
    database: z
      .object({
        dialect: z.literal("postgresql"),
        secretTransport: z.literal("owner-only-request-and-task-scoped-stdin"),
        maxConnections: z.literal(1),
      })
      .strict(),
    effects: effectsSchema,
    requestDigest: sha256Schema,
    status: z.enum(["applied", "no-op"]),
    version: z.literal(1),
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
    >
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
    >
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
    input: Extract<PreviewActivationPlanRequest, { action: "oauth.initialize" }>
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
      : request.action === "runtime-role.configure"
        ? digest(request.password)
        : undefined;
  return JSON.stringify({
    ...request,
    ...(request.action === "oauth.initialize"
      ? { authSecret: secretDigest }
      : request.action === "runtime-role.configure"
        ? { password: secretDigest }
        : {}),
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
            email: request.email,
            githubAccountId: request.githubAccountId,
            githubLogin: request.githubLogin,
            issuer: request.issuer,
            resource: request.resource,
            userId: request.userId,
            workspaceId: request.workspaceId,
          };
  return {
    action: request.action,
    authorityDigest: digest(JSON.stringify(authority)),
    requestDigest: digest(canonical),
    requestedAt: request.requestedAt,
    requiredConfirmationDigest: digest(`confirm\n${canonical}`),
    version: 1 as const,
  };
}

const emptyEffects: z.infer<typeof effectsSchema> = {
  accountRowsAffected: 0,
  jwksRowsAfter: 0,
  jwksRowsBefore: 0,
  membershipRowsAffected: 0,
  resourceRowsAfter: 0,
  resourceRowsBefore: 0,
  runtimeRoleAttributesExact: false,
  runtimeRoleCanConnect: false,
  runtimeRoleCanCreateSchemaObjects: false,
  runtimeRoleCanUseSchema: false,
  runtimeRoleCreated: false,
  runtimeRoleLogin: false,
  runtimeRoleMembershipCount: 0,
  runtimeRoleSequencePrivilegesExact: false,
  runtimeRoleTablePrivilegesExact: false,
  userRowsAffected: 0,
};

export const runtimeRoleReadbackSchema = z
  .object({
    bypassRls: z.literal(false),
    canConnect: z.literal(true),
    canCreateSchemaObjects: z.literal(false),
    canLogin: z.literal(true),
    canUseSchema: z.literal(true),
    createDatabase: z.literal(false),
    createRole: z.literal(false),
    inherits: z.literal(false),
    membershipCount: z.literal(0),
    replication: z.literal(false),
    sequencePrivilegesExact: z.literal(true),
    superuser: z.literal(false),
    tablePrivilegesExact: z.literal(true),
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
    Object.entries(apply).filter(([key]) => key !== "confirmationDigest")
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
    action: request.action,
    appliedAt: new Date(nowEpochMs).toISOString(),
    authorityDigest: plan.authorityDigest,
    database: {
      dialect: "postgresql",
      maxConnections: 1,
      secretTransport: "owner-only-request-and-task-scoped-stdin",
    },
    effects,
    requestDigest: plan.requestDigest,
    status: changed ? "applied" : "no-op",
    version: 1,
  });
}
