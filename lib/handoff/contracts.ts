import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisionResponseSchema } from "../provisioning/contracts";
import { builderAppIdSchema } from "../provisioning/names";
import { activeBuilderModelIdSchema } from "../integrations/active-model";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const repositoryName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/u);
const fullRepositoryName = z
  .string()
  .trim()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

export const builderHandoffIdSchema = z.string().uuid();
export const builderHandoffDestinationSchema = z.enum(["codex", "cursor"]);

export const builderHandoffIntentSchema = z
  .object({
    appId: builderAppIdSchema,
    appName: z.string().trim().min(1).max(120),
    brief: z.string().trim().min(1).max(32_000),
    connections: z.array(z.string().trim().min(1).max(100)).max(50),
    // Keep legacy stored intents byte-compatible with their request digests.
    // Consumers interpret an omitted destination as Codex.
    destination: builderHandoffDestinationSchema.optional(),
    modelId: activeBuilderModelIdSchema,
    providers: z
      .object({
        githubInstallationId: z
          .string()
          .regex(/^[1-9][0-9]*$/u)
          .optional(),
        vercelInstallationId: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    provisioning: builderProvisionResponseSchema.optional(),
    provisioningRequestDigest: sha256.optional(),
    provisioningRequestId: z.string().uuid().optional(),
    repository: z
      .object({
        private: z.boolean(),
        requestedName: repositoryName,
        resolvedFullName: fullRepositoryName.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      (intent.provisioningRequestId === undefined) !==
      (intent.provisioningRequestDigest === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "A provisioning request ID and digest must be recorded together.",
        path: ["provisioningRequestId"],
      });
    if (
      intent.provisioning !== undefined &&
      (intent.provisioning.requestId !== intent.provisioningRequestId ||
        intent.provisioning.requestDigest !== intent.provisioningRequestDigest)
    )
      context.addIssue({
        code: "custom",
        message: "A provisioning outcome must match its exact server-owned request.",
        path: ["provisioning"],
      });
    if (intent.provisioning === undefined && intent.provisioningRequestId !== undefined)
      context.addIssue({
        code: "custom",
        message: "A referenced provisioning request requires its readback.",
        path: ["provisioning"],
      });
  });

export type BuilderHandoffIntent = z.infer<typeof builderHandoffIntentSchema>;

export const builderHandoffRecordSchema = z
  .object({
    authority: hostedTenantAuthoritySchema,
    createdAt: z.date(),
    creationRequestId: z.string().uuid(),
    expiresAt: z.date(),
    handoffId: builderHandoffIdSchema,
    intent: builderHandoffIntentSchema,
    redeemedAt: z.date().optional(),
    requestDigest: sha256,
    sessionId: z.string().min(1).max(200).optional(),
    version: z.literal(1),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.expiresAt <= record.createdAt)
      context.addIssue({
        code: "custom",
        message: "A handoff must expire after it is created.",
        path: ["expiresAt"],
      });
    if ((record.redeemedAt === undefined) !== (record.sessionId === undefined))
      context.addIssue({
        code: "custom",
        message: "A redeemed handoff must bind exactly one session.",
        path: ["sessionId"],
      });
    if (
      record.redeemedAt !== undefined &&
      (record.redeemedAt < record.createdAt || record.redeemedAt > record.expiresAt)
    )
      context.addIssue({
        code: "custom",
        message: "A handoff must be redeemed during its initial lifetime.",
        path: ["redeemedAt"],
      });
  });

export type BuilderHandoffRecord = z.infer<typeof builderHandoffRecordSchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function builderHandoffRequestDigest(input: {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  creationRequestId: string;
  intent: BuilderHandoffIntent;
}) {
  return createHash("sha256")
    .update(
      canonical({
        authority: hostedTenantAuthoritySchema.parse(input.authority),
        creationRequestId: z.string().uuid().parse(input.creationRequestId),
        intent: builderHandoffIntentSchema.parse(input.intent),
        version: 1,
      }),
    )
    .digest("hex");
}
