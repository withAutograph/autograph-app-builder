/* oxlint-disable sonarjs/expression-complexity -- Exact branch, receiver and isolated resource facts jointly define immutable setup intent. */
import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderAppIdSchema } from "./names";
import { integrationCapabilityResourceSchema } from "./app-integration-capability-contract";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
const neon = z.strictObject({
  projectId: id,
  branchId: id,
  endpointId: id,
  source: z.literal("synthetic-only"),
});
const controlResource = integrationCapabilityResourceSchema.omit({ runtimeRole: true });
const planPointer = z.strictObject({ operationRef: z.uuid(), planDigest: digest });
const canonical = (value: z.infer<ReturnType<typeof z.json>>): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Canonical serialization branches only on a parsed JSON representation.
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      })
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const centralHostCanonicalBytes = (value: z.infer<ReturnType<typeof z.json>>) =>
  Buffer.from(canonical(z.json().parse(value)));
export const centralHostSetupEffects = [
  "prepare-central-resources",
  "install-central-schema",
  "register-deployment-receiver",
  "authorize-central-inspector",
  "bind-central-preview-runtime",
  "publish-central-host-source",
] as const;
export const centralHostCallerEffects = ["authorize-app-central-caller"] as const;
const profile = z.strictObject({ id, digest });
const control = z.strictObject({
  resource: controlResource,
  centralRuntimeRole: sqlName.refine((value) => !["postgres", "neondb_owner"].includes(value)),
  neon,
  schemaSha256: digest,
});
const provider = z.strictObject({
  kind: z.literal("quickbooksSandbox"),
  projectId: id,
  integrationId: id,
  authorizationOrigins: z.array(origin).min(1),
  payloadHosts: z.array(id).min(1),
});
const selection = z.strictObject({ sessionId: id, initiatingAppId: builderAppIdSchema });
const target = z.strictObject({
  projectId: id,
  teamId: id,
  installationId: id,
  environment: z.literal("preview"),
  serviceId: z.literal("integrations"),
  framework: z.literal("services"),
  rootDirectory: z.literal("."),
});
const activation = z.strictObject({ keyId: id, publicKeyPem: id, publicKeySha256: digest });
export const centralHostSetupPlanSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("central-integration-host-setup-v1"),
    intentId: z.uuid(),
    authority: hostedTenantAuthoritySchema,
    selection,
    profile,
    resourceProfileId: id,
    target,
    control,
    provider,
    activation,
    source: z.strictObject({
      repositoryId: id,
      installationId: id,
      reviewedSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
      reviewDigest: digest,
      operationBranch: id,
      expectedBranchAbsent: z.literal(true),
      servicesManifestSha256: digest,
      serviceIds: z.array(id).min(1),
      configurationRef: id,
      configurationSha256: digest,
      applicationIngress: z.literal("signed-app-development-v1"),
      deploymentProfile: z.literal("isolated-central-integrations-v1").optional(),
      buildReceiptSha256: digest.optional(),
      workers: z.strictObject({
        resources: z.strictObject({ id: z.literal("neon-resource-bootstrap-v1"), sha256: digest }),
        schema: z.strictObject({
          id: z.literal("central-integration-bootstrap-v1"),
          sha256: digest,
        }),
      }),
    }),
    environment: z
      .array(
        z.strictObject({
          key: z
            .string()
            .regex(/^[A-Z_][A-Z0-9_]*$/u)
            .refine((key) => !key.startsWith("VERCEL_") && !key.startsWith("NEXT_PUBLIC_")),
          sha256: digest,
        }),
      )
      .min(1),
    receiver: z.strictObject({
      subscriptionRef: z.uuid(),
      publicOrigin: origin,
      path: z.string().startsWith("/api/central-integrations/deployment-events/"),
      events: z.tuple([z.literal("deployment.created"), z.literal("deployment.ready")]),
    }),
    inspector: z.strictObject({
      projectId: id,
      environment: z.enum(["preview", "production"]),
      targetEnvironment: z.literal("preview"),
      priorGrantSha256: digest,
    }),
    effects: z.tuple([
      z.literal("prepare-central-resources"),
      z.literal("install-central-schema"),
      z.literal("register-deployment-receiver"),
      z.literal("authorize-central-inspector"),
      z.literal("bind-central-preview-runtime"),
      z.literal("publish-central-host-source"),
    ]),
  })
  .superRefine((plan, context) => {
    if (
      plan.source.deploymentProfile !== undefined &&
      (plan.source.buildReceiptSha256 === undefined ||
        JSON.stringify(plan.source.serviceIds) !== JSON.stringify(["gateway", "integrations"]))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The explicit central machine profile requires its genuine source receipt and exact two-service graph",
      });
    }
    if (
      plan.source.operationBranch !== `builder/integrations-host/${plan.intentId}` ||
      plan.receiver.path !==
        `/api/central-integrations/deployment-events/${plan.receiver.subscriptionRef}` ||
      new Set(plan.environment.map((row) => row.key)).size !== plan.environment.length ||
      new Set(plan.source.serviceIds).size !== plan.source.serviceIds.length ||
      plan.control.centralRuntimeRole === plan.control.resource.migratorRole
    ) {
      context.addIssue({
        code: "custom",
        message: "Central setup must preserve its exact owned branch, receiver and isolated scope",
      });
    }
  });
export type CentralHostSetupPlan = z.infer<typeof centralHostSetupPlanSchema>;
export const centralHostCallerPlanSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("central-integration-host-caller-v1"),
  authority: hostedTenantAuthoritySchema,
  selection,
  profile,
  setup: planPointer,
  setupAuthority: hostedTenantAuthoritySchema,
  central: z.strictObject({
    projectId: id,
    teamId: id,
    installationId: id,
    providerDeploymentId: id,
    immutableOrigin: origin,
    configurationSha256: digest,
  }),
  caller: z.strictObject({
    projectId: id,
    ownerId: id,
    environment: z.literal("production"),
    targetEnvironment: z.literal("preview"),
    provisioningRequestId: z.uuid(),
    provisioningDigest: digest,
    priorGrantSha256: digest,
  }),
  effects: z.tuple([z.literal("authorize-app-central-caller")]),
});
export type CentralHostCallerPlan = z.infer<typeof centralHostCallerPlanSchema>;
export const centralHostPlanDigest = (plan: CentralHostSetupPlan | CentralHostCallerPlan) =>
  hash(
    canonical(
      plan.kind === "central-integration-host-setup-v1"
        ? centralHostSetupPlanSchema.parse(plan)
        : centralHostCallerPlanSchema.parse(plan),
    ),
  );
export const centralHostOperationRef = (plan: CentralHostSetupPlan | CentralHostCallerPlan) => {
  const value = centralHostPlanDigest(plan);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
};
export const centralHostReadyReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("central-integration-host-ready-v1"),
    authority: hostedTenantAuthoritySchema,
    setup: planPointer,
    callerSetup: planPointer,
    profile,
    resourceProfileId: id,
    control,
    activation,
    provider,
    deployment: z.strictObject({
      projectId: id,
      teamId: id,
      installationId: id,
      environment: z.literal("preview"),
      serviceId: z.literal("integrations"),
      providerDeploymentId: id,
      immutableOrigin: origin,
      configurationRef: id,
      configurationSha256: digest,
    }),
    caller: z.strictObject({
      projectId: id,
      ownerId: id,
      environment: z.literal("production"),
      trustedSourcesGrantSha256: digest,
    }),
  })
  .superRefine((receipt, context) => {
    try {
      if (!receipt.activation.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
        throw new Error("public_key_required");
      const key = createPublicKey(receipt.activation.publicKeyPem);
      if (
        key.asymmetricKeyType !== "ed25519" ||
        hash(key.export({ format: "der", type: "spki" })) !== receipt.activation.publicKeySha256
      )
        throw new Error("public_key_mismatch");
    } catch {
      context.addIssue({
        code: "custom",
        message: "Exact central public verification key required",
      });
    }
  });
export type CentralIntegrationHostReadyReceipt = z.infer<typeof centralHostReadyReceiptSchema>;
