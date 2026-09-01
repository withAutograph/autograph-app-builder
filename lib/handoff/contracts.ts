import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisionResponseSchema } from "../provisioning/contracts";
import { builderAppIdSchema } from "../provisioning/names";

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

export const builderHandoffIntentSchema = z
  .object({
    appName: z.string().trim().min(1).max(120),
    appId: builderAppIdSchema,
    brief: z.string().trim().min(1).max(32_000),
    repository: z
      .object({
        requestedName: repositoryName,
        private: z.boolean(),
        resolvedFullName: fullRepositoryName.optional(),
      })
      .strict(),
    modelId: z.string().trim().min(1).max(200),
    connections: z.array(z.string().trim().min(1).max(100)).max(50),
    provisioningRequestId: z.string().uuid().optional(),
    provisioningRequestDigest: sha256.optional(),
    provisioning: builderProvisionResponseSchema.optional(),
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      (intent.provisioningRequestId === undefined) !==
      (intent.provisioningRequestDigest === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["provisioningRequestId"],
        message:
          "A provisioning request ID and digest must be recorded together.",
      });
    if (
      intent.provisioning !== undefined &&
      (intent.provisioning.requestId !== intent.provisioningRequestId ||
        intent.provisioning.requestDigest !== intent.provisioningRequestDigest)
    )
      context.addIssue({
        code: "custom",
        path: ["provisioning"],
        message:
          "A provisioning outcome must match its exact server-owned request.",
      });
    if (
      intent.provisioning === undefined &&
      intent.provisioningRequestId !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["provisioning"],
        message: "A referenced provisioning request requires its readback.",
      });
  });

export type BuilderHandoffIntent = z.infer<typeof builderHandoffIntentSchema>;

export const builderHandoffRecordSchema = z
  .object({
    version: z.literal(1),
    handoffId: builderHandoffIdSchema,
    authority: hostedTenantAuthoritySchema,
    creationRequestId: z.string().uuid(),
    requestDigest: sha256,
    intent: builderHandoffIntentSchema,
    createdAt: z.date(),
    expiresAt: z.date(),
    redeemedAt: z.date().optional(),
    sessionId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.expiresAt <= record.createdAt)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A handoff must expire after it is created.",
      });
    if ((record.redeemedAt === undefined) !== (record.sessionId === undefined))
      context.addIssue({
        code: "custom",
        path: ["sessionId"],
        message: "A redeemed handoff must bind exactly one session.",
      });
    if (
      record.redeemedAt !== undefined &&
      (record.redeemedAt < record.createdAt ||
        record.redeemedAt > record.expiresAt)
    )
      context.addIssue({
        code: "custom",
        path: ["redeemedAt"],
        message: "A handoff must be redeemed during its initial lifetime.",
      });
  });

export type BuilderHandoffRecord = z.infer<typeof builderHandoffRecordSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function builderHandoffRequestDigest(input: {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  creationRequestId: string;
  intent: BuilderHandoffIntent;
}) {
  return createHash("sha256")
    .update(
      canonical({
        version: 1,
        authority: hostedTenantAuthoritySchema.parse(input.authority),
        creationRequestId: z.string().uuid().parse(input.creationRequestId),
        intent: builderHandoffIntentSchema.parse(input.intent),
      }),
    )
    .digest("hex");
}
