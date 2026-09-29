import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { BuilderProvisionAuthority } from "./journal";
import { builderAppIdSchema } from "./names";

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
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
  authenticatedBehavior: z.literal("unassessed"),
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
  credentialReference: z
    .strictObject({
      configurationId: z.string().min(1),
      environmentId: z.string().min(1),
    })
    .optional(),
  kind: z.literal("app-runtime"),
  leaseExpiresAt: z.iso.datetime({ offset: true }).optional(),
  leaseId: z.uuid().optional(),
  privateState: encryptedStateSchema.optional(),
  proof: hostedRuntimeProofSchema.optional(),
  request: hostedRuntimeTargetSchema,
  status: z.enum(["pending", "prepared", "failed"]),
  step: z.enum(["reserved", "planned", "prepared", "verified", "bound"]),
  version: z.literal(1),
});

export type HostedRuntimeJournalRecord = z.infer<typeof hostedRuntimeJournalRecordSchema>;
export interface HostedRuntimeJournalRow {
  record: HostedRuntimeJournalRecord;
  revision: number;
}
export interface HostedRuntimeJournalStore {
  reserve: (input: {
    authority: BuilderProvisionAuthority;
    target: HostedRuntimeTarget;
    approvedByCallId: string;
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
