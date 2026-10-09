import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { BuilderProvisionAuthority } from "./journal";
import { builderAppIdSchema } from "./names";
import { hostedOperatorRecordSchema, retainedOperatorAuthSchema } from "./hosted-operator-contract";
import type { RetainedOperatorAuth } from "./hosted-operator-contract";

export const hostedRuntimeTargetSchema = z.strictObject({
  appId: builderAppIdSchema,
  branch: z
    .string()
    .min(1)
    .refine((value) => !/[\p{Cc}]/u.test(value)),
  environment: z.literal("preview"),
  installationId: z.string().min(1),
  projectId: z.string().min(1),
  scopeId: z.string().min(1),
  scopeType: z.enum(["team", "user"]),
  sessionId: z.string().min(1),
});

export type HostedRuntimeTarget = z.infer<typeof hostedRuntimeTargetSchema>;

export const hostedRuntimeProofSchema = z.strictObject({
  actors: z.number().int().nonnegative(),
  artifactHash: z
    .string()
    .regex(/^(?:sha256:)?[a-f0-9]{64}$/u)
    .transform((value) => value.replace(/^sha256:/u, "")),
  authenticatedBehavior: z.literal("unassessed"),
  // Legacy journal proofs remain inspectable; protected operator readiness requires this manifest identity.
  manifestSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  releaseId: z.string().min(1),
  tenants: z.number().int().positive(),
});

const encryptedStateSchema = z.strictObject({
  encryptedToken: z.string(),
  keyVersion: z.string().min(1),
  tokenIv: z.string().min(1),
  tokenTag: z.string().min(1),
});

export const hostedRuntimeJournalRecordSchema = z.strictObject({
  approvedByCallId: z.string().min(1),
  cleanupApprovedByCallId: z.string().min(1).optional(),
  credentialReference: z
    .strictObject({
      configurationId: z.string().min(1),
      environmentId: z.string().min(1),
    })
    .optional(),
  environmentBound: z.boolean().optional(),
  kind: z.literal("app-runtime"),
  leaseExpiresAt: z.iso.datetime({ offset: true }).optional(),
  leaseId: z.uuid().optional(),
  operator: hostedOperatorRecordSchema.optional(),
  privateState: encryptedStateSchema.optional(),
  proof: hostedRuntimeProofSchema.optional(),
  request: hostedRuntimeTargetSchema,
  retainedAuth: retainedOperatorAuthSchema.optional(),
  status: z.enum(["pending", "prepared", "failed", "cleaning", "cleaned"]),
  step: z.enum([
    "reserved",
    "planned",
    "prepared",
    "verified",
    "bound",
    "environment-removed",
    "cleaned",
  ]),
  version: z.literal(1),
});

export type HostedRuntimeJournalRecord = z.infer<typeof hostedRuntimeJournalRecordSchema>;
/** Structural completion evidence only. Callers must independently recheck owner
 * authorization and the original approval before using or materializing it. */
export const retainedOperatorAuthFromJournal = (
  record: HostedRuntimeJournalRecord,
): RetainedOperatorAuth | undefined => {
  const { operator } = record;
  if (
    operator === undefined ||
    record.privateState === undefined ||
    operator.pendingEffectId !== undefined ||
    operator.pendingEffectAttempt !== undefined
  ) {
    return undefined;
  }
  const completed =
    operator.plan.stage === "auth-bootstrap"
      ? record.status === "pending" && record.step === "reserved"
      : [
          record.status === "prepared",
          record.step === "bound",
          record.environmentBound === true,
          record.proof?.manifestSha256 === operator.plan.release.sha256,
          record.proof?.releaseId === operator.plan.release.id,
        ].every(Boolean);
  if (!completed) {
    return undefined;
  }
  const parsed = retainedOperatorAuthSchema.safeParse({
    approvalId: operator.approvalId,
    approvedByCallId: record.approvedByCallId,
    authPreparation: operator.authPreparation,
    fenceGeneration: operator.fenceGeneration,
    gatewayEnvironment: operator.gatewayEnvironment,
    operationRef: operator.operationRef,
    plan: operator.plan,
    planDigest: operator.planDigest,
    receipts: operator.receipts,
  });
  return parsed.success ? parsed.data : undefined;
};
export interface HostedRuntimeJournalRow {
  record: HostedRuntimeJournalRecord;
  revision: number;
}
export interface HostedRuntimeJournalStore {
  reserve: (input: {
    authority: BuilderProvisionAuthority;
    target: HostedRuntimeTarget;
    approvedByCallId: string;
    operator?: z.infer<typeof hostedOperatorRecordSchema>;
    now: Date;
  }) => Promise<HostedRuntimeJournalRow>;
  read: (input: {
    authority: BuilderProvisionAuthority;
    target: HostedRuntimeTarget;
  }) => Promise<HostedRuntimeJournalRow | undefined>;
  compareAndSet: (input: {
    authority: BuilderProvisionAuthority;
    target: HostedRuntimeTarget;
    record: HostedRuntimeJournalRecord;
    expectedRevision: number;
    now: Date;
  }) => Promise<HostedRuntimeJournalRow | undefined>;
  /** Atomically allocate once for this leased approved operation in the same journal row. */
  reserveFenceGeneration: (input: {
    authority: BuilderProvisionAuthority;
    target: HostedRuntimeTarget;
    expectedRevision: number;
    leaseId: string;
    operationRef: string;
    now: Date;
  }) => Promise<HostedRuntimeJournalRow | undefined>;
}

/** Stable across source revisions and replacement sandboxes; never uses ambient provider authority. */
export const hostedRuntimeIdentity = (
  authorityInput: BuilderProvisionAuthority,
  targetInput: HostedRuntimeTarget,
) => {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  const target = hostedRuntimeTargetSchema.parse(targetInput);
  const digest = createHash("sha256")
    .update(JSON.stringify({ authority, kind: "app-runtime", target }))
    .digest("hex");
  return {
    digest,
    requestId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
    runtimeId: `builder_${digest}`,
  };
};

export const updateHostedRuntimeJournal = async (input: {
  store: HostedRuntimeJournalStore;
  authority: BuilderProvisionAuthority;
  target: HostedRuntimeTarget;
  now: () => number;
  update: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord;
}): Promise<HostedRuntimeJournalRow> => {
  for (let attempt = 0; ; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- CAS retry preserves the entire valid workload.
    const current = await input.store.read(input);
    if (!current) {
      throw new Error("Runtime preparation journal is unavailable.");
    }
    const record = hostedRuntimeJournalRecordSchema.parse(
      input.update(structuredClone(current.record)),
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- writes follow their authoritative read.
    const saved = await input.store.compareAndSet({
      ...input,
      expectedRevision: current.revision,
      now: new Date(input.now()),
      record,
    });
    if (saved) {
      return saved;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- yield under contention without a total retry ceiling.
    await delay(Math.min(250, 5 * 2 ** Math.min(attempt, 6)));
  }
};
