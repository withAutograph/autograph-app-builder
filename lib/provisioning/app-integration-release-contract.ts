import { createHash } from "node:crypto";
import { z } from "zod";
import { preparedAppIntegrationCapabilitySchema } from "./app-integration-capability-contract";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const appIntegrationCapabilityPointerSchema = z.strictObject({
  operationRef: z.uuid(),
  planDigest: digest,
});
const scopeSchema = preparedAppIntegrationCapabilitySchema.omit({ privateConfiguration: true });
export const preparedIntegrationScopeDigest = (
  capability: z.infer<typeof preparedAppIntegrationCapabilitySchema>,
) => {
  const { privateConfiguration: privateReference, ...scope } =
    preparedAppIntegrationCapabilitySchema.parse(capability);
  void privateReference;
  return createHash("sha256")
    .update(JSON.stringify(scopeSchema.parse(scope)))
    .digest("hex");
};
export const appIntegrationReleaseAttachmentSchema = appIntegrationCapabilityPointerSchema
  .extend({
    capability: preparedAppIntegrationCapabilitySchema,
    readinessPath: z.string().min(1),
    scopeSha256: digest,
  })
  .superRefine((entry, context) => {
    if (
      entry.scopeSha256 !== preparedIntegrationScopeDigest(entry.capability) ||
      entry.readinessPath !== `/${entry.capability.appId}/api/integrations/readiness`
    ) {
      context.addIssue({
        code: "custom",
        message: "Exact prepared app integration scope and installed readiness path required",
      });
    }
  });
export type AppIntegrationReleaseAttachment = z.infer<typeof appIntegrationReleaseAttachmentSchema>;
export const appIntegrationOptionalEnvironmentKeys = [
  "APP_INTEGRATIONS_CAPABILITY",
  "APP_INTEGRATIONS_RUNTIME_CONFIGURATION",
] as const;
/** Read-only custody evidence; these keys are excluded from bootstrap's fifteen writes. */
export const retainedOptionalIntegrationBindingsSchema = z
  .array(
    z.strictObject({
      acceptedEnvId: z.string().min(1),
      key: z.enum(appIntegrationOptionalEnvironmentKeys),
      sha256: digest,
      sourceOperationRef: z.uuid(),
      sourcePlanDigest: digest,
    }),
  )
  .length(2)
  .refine((entries) => new Set(entries.map((entry) => entry.key)).size === 2)
  .transform((entries) => entries.toSorted((a, b) => a.key.localeCompare(b.key)));
export type RetainedOptionalIntegrationBindings = z.infer<
  typeof retainedOptionalIntegrationBindingsSchema
>;

/** New explicit app-only fence; old capability ciphertext and both provider rows remain retained. */
export const appIntegrationRemovalSchema = z
  .strictObject({
    authority: z.strictObject({
      active: z.literal(true),
      configurationRef: z.uuid(),
      configurationSha256: digest,
      expectedFencedGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      principalGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      principalName: z.string().min(1),
    }),
    bindingCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    kind: z.literal("disabled-app-integration-tombstone-v1"),
    scopeSha256: digest,
    sourceCapability: appIntegrationCapabilityPointerSchema,
    stoppedBindingsSha256: digest,
    worker: z.strictObject({
      reference: z.literal("app-integration-bootstrap-v1"),
      sha256: digest,
    }),
  })
  .superRefine((value, context) => {
    if (value.authority.expectedFencedGeneration !== value.authority.principalGeneration + 1) {
      context.addIssue({
        code: "custom",
        message: "A removal approval freezes exactly the next app-only authority generation",
      });
    }
  });
export const appIntegrationRemovalFenceProofSchema = z
  .strictObject({
    active: z.literal(false),
    operationRef: z.uuid(),
    principalGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    priorGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    stoppedBindingsSha256: digest,
  })
  .refine(
    (value) => value.principalGeneration === value.priorGeneration + 1,
    "Exact next fenced generation required",
  );
export type AppIntegrationRemoval = z.infer<typeof appIntegrationRemovalSchema>;
