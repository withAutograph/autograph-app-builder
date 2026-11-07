import { createHash } from "node:crypto";
import { z } from "zod";

/** Installer-described same-origin endpoint metadata, never a caller-selected network origin. */
export const appIntegrationReadinessPathSchema = z.string().refine((value) => {
  try {
    const url = new URL(value, "https://owned.invalid");
    return [
      value.startsWith("/"),
      !value.startsWith("//"),
      !value.includes("\\"),
      url.origin === "https://owned.invalid",
      url.pathname === value,
      !url.search,
      !url.hash,
    ].every(Boolean);
  } catch {
    return false;
  }
});
export const appIntegrationInstallReadinessSchema = z.strictObject({
  path: appIntegrationReadinessPathSchema,
  protocol: z.literal("app-integration-readiness-v1"),
});
const readIdentifier = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      // oxlint-disable-next-line unicorn/prefer-spread -- Retain the established Unicode iterator and frozen ASCII-control predicate.
      !Array.from(value).some(
        // oxlint-disable-next-line unicorn/prefer-code-point -- This predicate rejects only ASCII control units; retain its frozen accepted-character semantics.
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
export const appIntegrationReadObjectsSchema = z
  .record(
    z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    z.strictObject({
      destination: readIdentifier,
      objectName: readIdentifier,
      schedule: readIdentifier.optional(),
      selectedFieldMappings: z.record(readIdentifier, readIdentifier).optional(),
      selectedFields: z.record(readIdentifier, z.boolean()).optional(),
      selectedValueMappings: z
        .record(readIdentifier, z.record(readIdentifier, readIdentifier))
        .optional(),
    }),
  )
  .refine((value) => Object.keys(value).length > 0);
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recursive canonicalization receives only values admitted by appIntegrationReadObjectsSchema at the exported boundary.
const canonicalReadConfiguration = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalReadConfiguration).join(",")}]`;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Recursion branches over data already admitted by the strict exported configuration schema.
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
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReadConfiguration(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the actual schema parsing boundary for external read-object configuration.
export const appIntegrationReadObjectsDigest = (value: unknown) =>
  createHash("sha256")
    .update(canonicalReadConfiguration(appIntegrationReadObjectsSchema.parse(value)))
    .digest("hex");
export const appIntegrationProviderConfigurationSchema = z
  .strictObject({
    connectionProviderKey: z.string().min(1),
    provider: z.enum(["quickbooks", "xero", "ramp"]),
    readObjects: appIntegrationReadObjectsSchema,
    readObjectsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    recipeId: z.string().min(1),
    recipeVersion: z.string().min(1),
  })
  .superRefine((entry, context) => {
    if (appIntegrationReadObjectsDigest(entry.readObjects) !== entry.readObjectsSha256) {
      context.addIssue({
        code: "custom",
        message: "Exact provider read configuration digest required",
      });
    }
  });
export const appIntegrationMachineIngressSchema = z
  .array(
    z.strictObject({
      kind: z.enum([
        "readiness",
        "catalog-authority",
        "installation-authority",
        "quickbooks-ingress",
      ]),
      method: z.literal("POST"),
      path: appIntegrationReadinessPathSchema,
    }),
  )
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.kind)).size === entries.length &&
      new Set(entries.map((entry) => entry.path)).size === entries.length,
  );

export const appIntegrationsDescriptionSchema = z.strictObject({
  configuration: z
    .array(appIntegrationProviderConfigurationSchema)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.provider)).size === entries.length &&
        new Set(entries.map((entry) => entry.connectionProviderKey)).size === entries.length,
    )
    .optional(),
  contract: z.literal("app-integrations-development-v1"),
  machineIngress: appIntegrationMachineIngressSchema.optional(),
  readinessPath: appIntegrationReadinessPathSchema,
});
