import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { vercelProvisionDiagnosticSchema } from "./contracts";
import { builderAppIdSchema } from "./names";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z.url().refine((value) => {
  const parsed = new URL(value);
  return [
    parsed.protocol === "https:",
    parsed.username === "",
    parsed.password === "",
    parsed.pathname === "/",
    parsed.search === "",
    parsed.hash === "",
    parsed.origin === value,
  ].every(Boolean);
}, "An exact public HTTPS origin is required");
export const publicReleaseEffects = ["bind-production-runtime", "publish-release-source"] as const;
export const publicReleaseEffectSchema = z.enum(publicReleaseEffects);
export type PublicReleaseEffect = z.infer<typeof publicReleaseEffectSchema>;
export const publicReleaseSelectionSchema = z.strictObject({
  appId: builderAppIdSchema,
  sessionId: id,
});
export const publicReleasePlanSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("public-app-release-v1"),
  authority: hostedTenantAuthoritySchema,
  selection: publicReleaseSelectionSchema,
  project: z.strictObject({
    projectId: id,
    teamId: id,
    installationId: id,
    provisioningRequestId: z.uuid(),
    provisioningDigest: digest,
    framework: z.literal("services"),
    rootDirectory: z.literal("."),
    deploymentAccess: z.literal("public-app"),
    environment: z.literal("production"),
  }),
  source: z.strictObject({
    installationId: id,
    repositoryId: id,
    sourceBranch: id,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
    productionBranch: id,
    expectedProductionSha: z.string().regex(/^[a-f0-9]{40}$/u),
    reviewDigest: digest,
  }),
  runtime: z.strictObject({
    operationRef: z.uuid(),
    planDigest: digest,
    configurationRef: id,
    releaseId: id,
    providerEnvironment: z.literal("development"),
    syntheticOnly: z.literal(true),
  }),
  publicOrigin: origin,
  environment: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
        sha256: digest,
        priorBinding: z
          .strictObject({ id, operationRef: z.uuid(), valueSha256: digest })
          .optional(),
      }),
    )
    .min(1)
    .refine((rows) => new Set(rows.map((row) => row.key)).size === rows.length)
    .transform((rows) => rows.toSorted((left, right) => left.key.localeCompare(right.key))),
  effects: z.tuple([z.literal("bind-production-runtime"), z.literal("publish-release-source")]),
});
export type PublicReleasePlan = z.infer<typeof publicReleasePlanSchema>;
export const publicReleasePlanDigest = (plan: PublicReleasePlan) =>
  createHash("sha256")
    .update(JSON.stringify(publicReleasePlanSchema.parse(plan)))
    .digest("hex");
export const publicReleaseObservationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    status: z.literal("ready"),
    deploymentId: id,
    projectId: id,
    environment: z.literal("production"),
    publicOrigin: origin,
    releaseId: id,
  }),
]);
export type PublicReleaseObservation = z.infer<typeof publicReleaseObservationSchema>;
export const publicReleaseBindingStateSchema = z.strictObject({
  state: z.enum(["idle", "pending", "applied"]),
  acceptedEnvId: id.optional(),
});
export type PublicReleaseBindingState = z.infer<typeof publicReleaseBindingStateSchema>;
export const publicReleaseRecordSchema = z.strictObject({
  kind: z.literal("public-app-release-v1"),
  plan: publicReleasePlanSchema,
  planDigest: digest,
  bindings: z.record(z.string(), publicReleaseBindingStateSchema),
  effects: z.strictObject({
    "bind-production-runtime": z.enum(["idle", "pending", "applied"]),
    "publish-release-source": z.enum(["idle", "pending", "applied"]),
  }),
  observation: publicReleaseObservationSchema.optional(),
  lastProviderFailure: z
    .strictObject({
      phase: z.enum([...publicReleaseEffects, "observe-production"]),
      diagnostic: vercelProvisionDiagnosticSchema,
    })
    .optional(),
});
export type PublicReleaseRecord = z.infer<typeof publicReleaseRecordSchema>;
export type PublicReleaseAuthority = z.infer<typeof hostedTenantAuthoritySchema>;
export const publicReleaseOperationRef = (plan: PublicReleasePlan) => {
  const value = createHash("sha256")
    .update(`public-app-release-v1:${publicReleasePlanDigest(plan)}`)
    .digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
};

export const publicReleaseApprovalInputSchema = z
  .strictObject({
    operationRef: z.uuid(),
    planDigest: digest,
    plan: publicReleasePlanSchema,
  })
  .superRefine((input, context) => {
    if (
      input.operationRef !== publicReleaseOperationRef(input.plan) ||
      input.planDigest !== publicReleasePlanDigest(input.plan)
    ) {
      context.addIssue({
        code: "custom",
        message: "Public release approval must echo its exact saved plan",
      });
    }
  });
export type PublicReleaseApprovalInput = z.infer<typeof publicReleaseApprovalInputSchema>;
