import { publicReleaseProviderDiagnosticSchema } from "./public-release-provider-diagnostic";
import {
  appIntegrationReleaseAttachmentSchema,
  appIntegrationRemovalSchema,
  retainedOptionalIntegrationBindingsSchema,
} from "./app-integration-release-contract";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
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
export const publicReleaseEffects = [
  "fence-app-integration-authority",
  "bind-production-runtime",
  "publish-release-source",
] as const;
export const publicReleaseEffectSchema = z.enum(publicReleaseEffects);
export type PublicReleaseEffect = z.infer<typeof publicReleaseEffectSchema>;
export const publicReleaseSelectionSchema = z.strictObject({
  appId: builderAppIdSchema,
  sessionId: id,
});
export const publicReleaseSourceDeliveryScopeSchema = z.strictObject({
  kind: z.literal("builder-created-app-repository"),
  provisioningDigest: digest,
  provisioningRequestId: z.uuid(),
});
export const publicReleasePlanSchema = z
  .strictObject({
    authority: hostedTenantAuthoritySchema,
    effects: z.union([
      z.tuple([z.literal(publicReleaseEffects[1]), z.literal(publicReleaseEffects[2])]),
      z.tuple([
        z.literal(publicReleaseEffects[0]),
        z.literal(publicReleaseEffects[1]),
        z.literal(publicReleaseEffects[2]),
      ]),
    ]),
    environment: z
      .array(
        z.strictObject({
          key: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
          priorBinding: z
            .strictObject({ id, operationRef: z.uuid(), valueSha256: digest })
            .optional(),
          sha256: digest,
        }),
      )
      .min(1)
      .refine((rows) => new Set(rows.map((row) => row.key)).size === rows.length)
      .transform((rows) => rows.toSorted((left, right) => left.key.localeCompare(right.key))),
    integrationCapability: appIntegrationReleaseAttachmentSchema.optional(),
    integrationRemoval: appIntegrationRemovalSchema.optional(),
    kind: z.literal("public-app-release-v1"),
    project: z.strictObject({
      deploymentAccess: z.literal("public-app"),
      environment: z.literal("production"),
      framework: z.literal("services"),
      installationId: id,
      priorActiveDeploymentId: id.nullable().optional(),
      projectId: id,
      provisioningDigest: digest,
      provisioningRequestId: z.uuid(),
      rootDirectory: z.literal("."),
      teamId: id,
    }),
    publicOrigin: origin,
    /** Absence preserves the first additive release contract as application delivery. */
    purpose: z.enum(["auth-bootstrap", "application"]).optional(),
    retainedOptionalBindings: retainedOptionalIntegrationBindingsSchema.optional(),
    runtime: z.strictObject({
      configurationRef: id,
      operationRef: z.uuid(),
      planDigest: digest,
      providerEnvironment: z.literal("development"),
      realmEnrollmentRef: z.uuid().optional(),
      releaseId: id,
      syntheticOnly: z.literal(true),
    }),
    selection: publicReleaseSelectionSchema,
    source: z.strictObject({
      deliveryScope: publicReleaseSourceDeliveryScopeSchema,
      expectedProductionSha: z.string().regex(/^[a-f0-9]{40}$/u),
      installationId: id,
      productionBranch: id,
      repositoryId: id,
      reviewDigest: digest,
      sourceBranch: id,
      sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
    }),
    version: z.literal(1),
  })
  .superRefine((plan, context) => {
    if (plan.retainedOptionalBindings !== undefined) {
      const retainedBindings = plan.retainedOptionalBindings;
      const valid = [
        plan.purpose === "auth-bootstrap" ||
          (plan.purpose === "application" && plan.integrationRemoval !== undefined),
        plan.integrationCapability === undefined,
        !plan.environment.some((entry) =>
          retainedBindings.some((retained) => entry.key === retained.key),
        ),
      ];
      if (valid.includes(false)) {
        context.addIssue({
          code: "custom",
          message:
            "Existing optional bindings require an Auth bootstrap or explicit disabled-tombstone application release",
        });
      }
    }

    const removing = plan.integrationRemoval !== undefined;
    const invalidRemoval = [
      plan.purpose !== "application",
      plan.integrationCapability !== undefined,
      plan.retainedOptionalBindings === undefined,
    ].some(Boolean);
    if (
      removing !== plan.effects.some((effect) => effect === "fence-app-integration-authority") ||
      (removing && invalidRemoval)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Removal requires a fresh application approval with an ordered app-only authority fence and retained bindings",
      });
    }

    if (plan.integrationCapability !== undefined) {
      const attached = plan.integrationCapability;
      const checks = [
        plan.purpose === "application",
        attached.capability.appId === plan.selection.appId,
        attached.capability.release.id === plan.runtime.releaseId,
        plan.environment.some(
          (entry) =>
            entry.key === "APP_INTEGRATIONS_CAPABILITY" &&
            entry.sha256 ===
              createHash("sha256").update(JSON.stringify(attached.capability)).digest("hex"),
        ),
        plan.environment.some(
          (entry) =>
            entry.key === "APP_INTEGRATIONS_RUNTIME_CONFIGURATION" &&
            entry.sha256 === attached.capability.privateConfiguration.sha256,
        ),
      ];
      if (checks.includes(false)) {
        context.addIssue({
          code: "custom",
          message:
            "Optional integrations require a fresh explicit application release with both approved configuration keys",
        });
      }
    }

    if (
      plan.source.deliveryScope.provisioningRequestId !== plan.project.provisioningRequestId ||
      plan.source.deliveryScope.provisioningDigest !== plan.project.provisioningDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "Public source must use the normal app provisioning receipt",
      });
    }
  });

export type PublicReleasePlan = z.infer<typeof publicReleasePlanSchema>;
/** Runtime values determine whether the native Git publication must cause a fresh deployment. */
export const publicReleaseRequiresNativeGitEvent = (
  plan: Pick<PublicReleasePlan, "purpose" | "environment">,
) =>
  plan.purpose !== undefined &&
  plan.environment.some((entry) => entry.priorBinding?.valueSha256 !== entry.sha256);
/** Aggregate only: the loaded public runtime returns no individual key hash or value. */
export const publicReleaseRuntimeBindingDigest = (plan: Pick<PublicReleasePlan, "environment">) => {
  const manifest = plan.environment
    .map(({ key, sha256 }) => ({ key, sha256 }))
    .toSorted((a, b) => {
      if (a.key === b.key) {
        return 0;
      }
      return a.key < b.key ? -1 : 1;
    });
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
};
export const publicReleasePlanDigest = (plan: PublicReleasePlan) =>
  createHash("sha256")
    .update(JSON.stringify(publicReleasePlanSchema.parse(plan)))
    .digest("hex");
export const publicReleaseObservationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    deploymentId: id,
    environment: z.literal("production"),
    projectId: id,
    publicOrigin: origin,
    releaseId: id,
    status: z.literal("ready"),
  }),
]);
export type PublicReleaseObservation = z.infer<typeof publicReleaseObservationSchema>;
export const publicReleaseBindingStateSchema = z.strictObject({
  acceptedEnvId: id.optional(),
  state: z.enum(["idle", "pending", "applied"]),
});
export type PublicReleaseBindingState = z.infer<typeof publicReleaseBindingStateSchema>;
export const publicReleaseRecordSchema = z.strictObject({
  approvalReceipts: z.array(z.strictObject({ approvalId: id, approvedByCallId: id })).optional(),
  bindings: z.record(z.string(), publicReleaseBindingStateSchema),
  effects: z.strictObject({
    "bind-production-runtime": z.enum(["idle", "pending", "applied"]),
    "fence-app-integration-authority": z.enum(["idle", "pending", "applied"]).optional(),
    "publish-release-source": z.enum(["idle", "pending", "applied"]),
  }),
  executionLease: z
    .strictObject({ fenceGeneration: z.number().int().positive(), leaseId: z.uuid() })
    .optional(),
  kind: z.literal("public-app-release-v1"),
  lastProviderFailure: z
    .strictObject({
      diagnostic: publicReleaseProviderDiagnosticSchema,
      phase: z.enum([...publicReleaseEffects, "observe-production"]),
    })
    .optional(),
  observation: publicReleaseObservationSchema.optional(),
  plan: publicReleasePlanSchema,
  planDigest: digest,
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
    plan: publicReleasePlanSchema,
    planDigest: digest,
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
