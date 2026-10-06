import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
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
  observedAt: z.iso.datetime({ offset: true }),
  resourceVersion: id,
});
export type OperatorReceipt = z.infer<typeof operatorReceiptSchema>;
export const hostedOperatorRecordSchema = z.strictObject({
  approvalId: id.optional(),
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
export const operatorRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("plan"),
    operation: z.enum(["prepare", "cleanup"]),
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("execute"),
    callId: id,
    operationRef: z.uuid(),
    planDigest: digest,
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("status"),
    operationRef: z.uuid(),
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("bindings"),
    operationRef: z.uuid(),
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
  ];
  if (
    Object.keys(env).some((key) => !keys.includes(key)) ||
    keys.some((key) => !env[key]) ||
    env.BETTER_AUTH_APP_NAME !== "apps"
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
  return env;
};

export const sameOperatorSelection = (left: OperatorSelection, right: OperatorSelection) =>
  (["appId", "branch", "environment", "projectId", "sessionId"] as const).every(
    (key) => left[key] === right[key],
  );
