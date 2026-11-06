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
  branchId: id,
  endpointId: id,
  projectId: id,
  source: z.literal("synthetic-only"),
});
const controlResource = integrationCapabilityResourceSchema.omit({ runtimeRole: true });
const planPointer = z.strictObject({ operationRef: z.uuid(), planDigest: digest });
const canonical = (value: z.infer<ReturnType<typeof z.json>>): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Canonical serialization branches only on a parsed JSON representation.
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => {
        if (a < b) {
          return -1;
        }
        if (a > b) {
          return 1;
        }
        return 0;
      })
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
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
const profile = z.strictObject({ digest, id });
const control = z.strictObject({
  centralRuntimeRole: sqlName.refine((value) => !["postgres", "neondb_owner"].includes(value)),
  neon,
  resource: controlResource,
  schemaSha256: digest,
});
const provider = z.strictObject({
  authorizationOrigins: z.array(origin).min(1),
  integrationId: id,
  kind: z.literal("quickbooksSandbox"),
  payloadHosts: z.array(id).min(1),
  projectId: id,
});
const selection = z.strictObject({ initiatingAppId: builderAppIdSchema, sessionId: id });
const target = z.strictObject({
  environment: z.literal("preview"),
  framework: z.literal("services"),
  installationId: id,
  projectId: id,
  rootDirectory: z.literal("."),
  serviceId: z.literal("integrations"),
  teamId: id,
});
const activation = z.strictObject({ keyId: id, publicKeyPem: id, publicKeySha256: digest });
export const centralHostSetupPlanSchema = z
  .strictObject({
    activation,
    authority: hostedTenantAuthoritySchema,
    control,
    effects: z.tuple([
      z.literal("prepare-central-resources"),
      z.literal("install-central-schema"),
      z.literal("register-deployment-receiver"),
      z.literal("authorize-central-inspector"),
      z.literal("bind-central-preview-runtime"),
      z.literal("publish-central-host-source"),
    ]),
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
    inspector: z.strictObject({
      environment: z.enum(["preview", "production"]),
      priorGrantSha256: digest,
      projectId: id,
      targetEnvironment: z.literal("preview"),
    }),
    intentId: z.uuid(),
    kind: z.literal("central-integration-host-setup-v1"),
    profile,
    provider,
    receiver: z.strictObject({
      events: z.tuple([z.literal("deployment.created"), z.literal("deployment.ready")]),
      path: z.string().startsWith("/api/central-integrations/deployment-events/"),
      publicOrigin: origin,
      subscriptionRef: z.uuid(),
    }),
    resourceProfileId: id,
    selection,
    source: z.strictObject({
      applicationIngress: z.literal("signed-app-development-v1"),
      buildReceiptSha256: digest.optional(),
      configurationRef: id,
      configurationSha256: digest,
      deploymentProfile: z.literal("isolated-central-integrations-v1").optional(),
      expectedBranchAbsent: z.literal(true),
      installationId: id,
      operationBranch: id,
      repositoryId: id,
      reviewDigest: digest,
      reviewedSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
      serviceIds: z.array(id).min(1),
      servicesManifestSha256: digest,
      workers: z.strictObject({
        resources: z.strictObject({ id: z.literal("neon-resource-bootstrap-v1"), sha256: digest }),
        schema: z.strictObject({
          id: z.literal("central-integration-bootstrap-v1"),
          sha256: digest,
        }),
      }),
    }),
    target,
    version: z.literal(1),
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
  authority: hostedTenantAuthoritySchema,
  caller: z.strictObject({
    environment: z.literal("production"),
    ownerId: id,
    priorGrantSha256: digest,
    projectId: id,
    provisioningDigest: digest,
    provisioningRequestId: z.uuid(),
    targetEnvironment: z.literal("preview"),
  }),
  central: z.strictObject({
    configurationSha256: digest,
    immutableOrigin: origin,
    installationId: id,
    projectId: id,
    providerDeploymentId: id,
    teamId: id,
  }),
  effects: z.tuple([z.literal("authorize-app-central-caller")]),
  kind: z.literal("central-integration-host-caller-v1"),
  profile,
  selection,
  setup: planPointer,
  setupAuthority: hostedTenantAuthoritySchema,
  version: z.literal(1),
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
    activation,
    authority: hostedTenantAuthoritySchema,
    caller: z.strictObject({
      environment: z.literal("production"),
      ownerId: id,
      projectId: id,
      trustedSourcesGrantSha256: digest,
    }),
    callerSetup: planPointer,
    control,
    deployment: z.strictObject({
      configurationRef: id,
      configurationSha256: digest,
      environment: z.literal("preview"),
      immutableOrigin: origin,
      installationId: id,
      projectId: id,
      providerDeploymentId: id,
      serviceId: z.literal("integrations"),
      teamId: id,
    }),
    kind: z.literal("central-integration-host-ready-v1"),
    profile,
    provider,
    resourceProfileId: id,
    setup: planPointer,
    version: z.literal(1),
  })
  .superRefine((receipt, context) => {
    try {
      if (!receipt.activation.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")) {
        throw new Error("public_key_required");
      }
      const key = createPublicKey(receipt.activation.publicKeyPem);
      if (
        key.asymmetricKeyType !== "ed25519" ||
        hash(key.export({ format: "der", type: "spki" })) !== receipt.activation.publicKeySha256
      ) {
        throw new Error("public_key_mismatch");
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "Exact central public verification key required",
      });
    }
  });
export type CentralIntegrationHostReadyReceipt = z.infer<typeof centralHostReadyReceiptSchema>;
