import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedPrincipalSchema } from "../eve/hosted-auth";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const isPublicHttpsOrigin = (url: URL): boolean => {
  if (url.protocol !== "https:") {
    return false;
  }
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return false;
  }
  if (url.hostname.endsWith(".vercel.run")) {
    return false;
  }
  return true;
};
const httpsPublicOrigin = z
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (!isPublicHttpsOrigin(url)) {
      ctx.addIssue({ code: "custom", message: "Public Gateway origin must be exact HTTPS origin" });
    }
  })
  .transform((value) => new URL(value).origin);
export const operatorSelectionSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  branch: id.refine((value) => !/[\p{Cc}]/u.test(value)),
  environment: z.literal("preview"),
  projectId: id,
  sessionId: id,
});
const databaseResource = z
  .strictObject({
    database: sqlName,
    migratorRole: sqlName,
    resourceId: id,
    runtimeRole: sqlName,
  })
  .refine((value) => value.runtimeRole !== value.migratorRole);
/** Resolved by the protected planner from independently verified owner/provider/artifact state. */
export const hostedOperatorPlanSchema = z
  .strictObject({
    access: z.array(
      z.strictObject({ actorId: id, organizationId: id, roles: z.array(sqlName).min(1) }),
    ),
    action: z.enum(["prepare", "cleanup"]),
    appDatabase: databaseResource,
    authDatabase: databaseResource,
    contextId: id,
    cost: z.strictObject({
      class: z.enum(["shared-recovery-group", "independent-service"]),
      description: id,
      owner: id,
    }),
    effects: z
      .array(
        z.strictObject({
          description: id,
          id,
          kind: z.enum([
            "resources",
            "install",
            "access",
            "bindings",
            "revoke",
            "remove-bindings",
            "retire",
          ]),
        }),
      )
      .min(1),
    installer: z.strictObject({ reference: id, sha256: digest }),
    neon: z.strictObject({
      branchId: id,
      connectionRef: id,
      endpoint: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
      projectId: id,
      source: z.literal("synthetic-only"),
    }),
    // Optional only when parsing persisted protected-operator-v1 records created before
    // native Gateway origins were part of the verified plan.
    publicGateway: z
      .strictObject({
        branch: id,
        origin: httpsPublicOrigin,
        projectId: id,
      })
      .optional(),
    release: z.strictObject({ artifactRef: id, id, sha256: digest }),
    retention: z.strictObject({ expiresAt: z.iso.datetime({ offset: true }), policy: id }),
    selection: operatorSelectionSchema,
    version: z.literal(1),
  })
  .superRefine((plan, ctx) => {
    if (
      new Set(plan.effects.map((effect) => effect.id)).size !== plan.effects.length ||
      plan.appDatabase.database === plan.authDatabase.database ||
      plan.appDatabase.runtimeRole === plan.authDatabase.runtimeRole
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Resources and effects must have distinct identities.",
      });
    }
    if (
      plan.publicGateway &&
      (plan.publicGateway.branch !== plan.selection.branch ||
        plan.publicGateway.projectId !== plan.selection.projectId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Public Gateway origin must be bound to the selected Preview project and branch.",
        path: ["publicGateway"],
      });
    }
    // Each phase has an observed receipt, including a no-op verification for already-existing resources.
    // Authority is opened only after install/grant verification, and closed before retirement.
    const phases =
      plan.action === "prepare"
        ? ["resources", "install", "access", "bindings"]
        : ["revoke", "remove-bindings", "retire"];
    const kinds = plan.effects.map((effect) => effect.kind);
    const groups = kinds.filter((kind, index) => index === 0 || kind !== kinds[index - 1]);
    if (JSON.stringify(groups) !== JSON.stringify(phases)) {
      ctx.addIssue({
        code: "custom",
        message: "Effects must include every ordered authorization phase.",
      });
    }
  });
export type HostedOperatorPlan = z.infer<typeof hostedOperatorPlanSchema>;
export type OperatorSelection = z.infer<typeof operatorSelectionSchema>;
export const operatorReceiptSchema = z.strictObject({
  effectId: id,
  /** Present on new protected grant/revoke checkpoints; absent in existing v1 receipts. */
  fenceGeneration: z.number().int().positive().optional(),
  observedAt: z.iso.datetime({ offset: true }),
  resourceVersion: id,
});
export type OperatorReceipt = z.infer<typeof operatorReceiptSchema>;
export const hostedOperatorRecordSchema = z.strictObject({
  approvalId: id.optional(),
  /** Shared across Auth and kernel rows; allocated once by the existing journal CAS. */
  fenceGeneration: z.number().int().positive().optional(),
  mode: z.literal("protected-operator-v1"),
  operationRef: z.uuid(),
  pendingEffectId: id.optional(),
  plan: hostedOperatorPlanSchema,
  planDigest: digest,
  receipts: z.array(operatorReceiptSchema),
});
export const operatorPlanDigest = (input: HostedOperatorPlan) =>
  createHash("sha256")
    .update(JSON.stringify(hostedOperatorPlanSchema.parse(input)))
    .digest("hex");
/** Private server-derived claims; the operator re-reads their durable authority. */
export const operatorOwnerContextSchema = z
  .strictObject({
    adapterGeneration: z.number().int().positive(),
    adapterSessionId: z.string().min(1).max(200),
    authority: hostedTenantAuthoritySchema,
    principal: hostedPrincipalSchema,
    sessionId: z.string().min(1).max(200),
    sourceHandoffId: z.uuid(),
  })
  .superRefine((value, context) => {
    if (
      (["audience", "issuer", "ownerUserId", "workspaceId"] as const).some(
        (key) => value.principal[key] !== value.authority[key],
      )
    ) {
      context.addIssue({ code: "custom", message: "Operator owner claims disagree" });
    }
  });
export type OperatorOwnerContext = z.infer<typeof operatorOwnerContextSchema>;
export const operatorRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("plan"),
    operation: z.enum(["prepare", "cleanup"]),
    ownerContext: operatorOwnerContextSchema.optional(),
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("execute"),
    callId: id,
    operationRef: z.uuid(),
    ownerContext: operatorOwnerContextSchema.optional(),
    planDigest: digest,
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("status"),
    operationRef: z.uuid(),
    ownerContext: operatorOwnerContextSchema.optional(),
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("bindings"),
    operationRef: z.uuid(),
    ownerContext: operatorOwnerContextSchema.optional(),
    selection: operatorSelectionSchema,
  }),
]);
export type OperatorRequest = z.infer<typeof operatorRequestSchema>;
export const operatorPublicResultSchema = z.strictObject({
  appId: id,
  authenticatedBehavior: z.literal("unassessed"),
  code: z
    .enum([
      "protected_operator_required",
      "authorization_required",
      "resource_mismatch",
      "operation_in_progress",
      "reconciliation_required",
      "operator_unavailable",
      "legacy_runtime_requires_migration",
    ])
    .optional(),
  operationRef: z.uuid().optional(),
  plan: hostedOperatorPlanSchema.optional(),
  planDigest: digest.optional(),
  status: z.enum(["planned", "pending", "prepared", "cleaned", "blocked"]),
});
export type OperatorPublicResult = z.infer<typeof operatorPublicResultSchema>;
export class HostedOperatorError extends Error {
  readonly code: NonNullable<OperatorPublicResult["code"]>;
  constructor(code: NonNullable<OperatorPublicResult["code"]>) {
    super(code);
    this.name = "HostedOperatorError";
    this.code = code;
  }
}

/** Shared strict projection validation; no raw private state or alternate credential key is accepted. */
export const restrictedOperatorEnvironment = (
  plan: HostedOperatorPlan,
  input: Record<string, string>,
): Record<string, string> => {
  const env = z.record(z.string(), z.string()).parse(input);
  const appKey = `${plan.selection.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
  const keys = [
    appKey,
    "PLATFORM_AUTH_DATABASE_URL",
    "BETTER_AUTH_APP_NAME",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    ...(plan.publicGateway ? ["PLATFORM_PUBLIC_ORIGIN"] : []),
  ];
  const allowedKeys = new Set(keys);
  if (Object.keys(env).some((key) => !allowedKeys.has(key))) {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (keys.some((key) => !env[key])) {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (env.BETTER_AUTH_APP_NAME !== "apps") {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (
    plan.publicGateway &&
    (env.BETTER_AUTH_URL !== plan.publicGateway.origin ||
      env.PLATFORM_PUBLIC_ORIGIN !== plan.publicGateway.origin)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  for (const [key, resource] of [
    [appKey, plan.appDatabase],
    ["PLATFORM_AUTH_DATABASE_URL", plan.authDatabase],
  ] as const) {
    const url = new URL(env[key]);
    const valid = [
      ["postgres:", "postgresql:"].includes(url.protocol),
      url.hostname.replace(/-pooler(?=\.)/u, "") === plan.neon.endpoint,
      url.pathname === `/${resource.database}`,
      decodeURIComponent(url.username) === resource.runtimeRole,
      url.password !== "",
      ["", "5432"].includes(url.port),
      url.hash === "",
      url.searchParams.getAll("sslmode").length === 1,
      url.searchParams.get("sslmode") === "verify-full",
      [...url.searchParams.keys()].every((name) => ["sslmode", "channel_binding"].includes(name)),
      url.searchParams.getAll("channel_binding").length <= 1,
      !url.searchParams.has("channel_binding") ||
        url.searchParams.get("channel_binding") === "require",
    ];
    if (valid.includes(false)) {
      throw new HostedOperatorError("resource_mismatch");
    }
  }
  const origin = new URL(env.BETTER_AUTH_URL);
  const validOrigin = [
    origin.protocol === "https:",
    origin.username === "",
    origin.password === "",
    origin.pathname === "/",
    origin.search === "",
    origin.hash === "",
    env.BETTER_AUTH_SECRET.length >= 32,
  ];
  if (validOrigin.includes(false)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (plan.publicGateway && origin.origin !== plan.publicGateway.origin) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return env;
};

export const sameOperatorSelection = (left: OperatorSelection, right: OperatorSelection) =>
  (["appId", "branch", "environment", "projectId", "sessionId"] as const).every(
    (key) => left[key] === right[key],
  );
