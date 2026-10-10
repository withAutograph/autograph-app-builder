/* oxlint-disable eslint/max-classes-per-file, sonarjs/no-duplicate-string -- The closed contract groups its two safe error classes and explicit state literals. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { CustodySecretPort } from "./vercel-token-key-custody-secret";

const id = z.string().min(1).max(512);
const instant = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const custodyKind = "vercel-token-key-custody-v1" as const;
export const custodySecretKey = "VERCEL_INTEGRATION_TOKEN_KEY" as const;
export const custodyVersionKey = "VERCEL_INTEGRATION_TOKEN_KEY_VERSION" as const;
export const canonicalSourceActorSchema = hostedTenantAuthoritySchema;
export type CanonicalSourceActor = z.infer<typeof canonicalSourceActorSchema>;
export const custodyPlanSchema = z
  .strictObject({
    action: z.literal("transfer-active-vercel-token-key-to-operator-preview"),
    actorAuthorityDigest: digest,
    approvalExpiresAt: instant,
    destination: z.strictObject({
      environment: z.literal("preview"),
      gitBranch: z.null(),
      key: z.literal(custodySecretKey),
      projectId: id,
      requiredVersion: z.literal("v1"),
      teamId: id,
      type: z.literal("sensitive"),
      versionKey: z.literal(custodyVersionKey),
      write: z.literal("create-only"),
    }),
    installationId: id,
    operationRef: z.uuid(),
    ownerSessionId: id,
    source: z.strictObject({
      deploymentId: id,
      environment: z.literal("production"),
      key: z.literal(custodySecretKey),
      keyVersion: z.literal("v1"),
      projectId: id,
      teamId: id,
      versionKey: z.literal(custodyVersionKey),
    }),
    version: z.literal(1),
  })
  .refine(
    (plan) =>
      plan.source.teamId === plan.destination.teamId &&
      plan.source.projectId !== plan.destination.projectId,
  );
export type CustodyPlan = z.infer<typeof custodyPlanSchema>;
export const trustedCustodySetupGrantSchema = z.strictObject({
  approvalRef: id,
  approvedAt: instant,
  approvedPlanDigest: digest,
  expiresAt: instant,
  grantRef: id,
  operationRef: z.uuid(),
  originalActor: canonicalSourceActorSchema,
  ownerSessionId: id,
  scope: z.literal("source-global-active-v1-key-custody"),
  version: z.literal(1),
});
export type TrustedCustodySetupGrant = z.infer<typeof trustedCustodySetupGrantSchema>;
export const custodySecretMetadataSchema = z.strictObject({
  gitBranch: z.null(),
  id,
  key: z.literal(custodySecretKey),
  projectId: id,
  target: z.tuple([z.literal("preview")]),
  teamId: id,
  type: z.literal("sensitive"),
});
export type CustodySecretMetadata = z.infer<typeof custodySecretMetadataSchema>;
export const custodyReceiptSchema = z.strictObject({
  approvalRef: id,
  grantDigest: digest,
  keyVersion: z.literal("v1"),
  operationRef: z.uuid(),
  planDigest: digest,
  possession: z.literal("verified"),
  providerRowId: id,
  receivingDeploymentId: id,
  verifiedAt: instant,
});
export type CustodyReceipt = z.infer<typeof custodyReceiptSchema>;
const canonical = (value: z.infer<ReturnType<typeof z.json>>): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recursive JSON value was parsed by z.json before canonical serialization.
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => {
        if (a === b) {
          return 0;
        }
        return a < b ? -1 : 1;
      })
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- The canonical digest accepts each parsed metadata owner shape without weakening those callers to unknown.
export const custodyDigest = <Value extends object | undefined>(value: Value) => {
  const canonicalJsonText = JSON.stringify(value ?? null);
  const parsedJson = z.json().parse(JSON.parse(canonicalJsonText));
  return createHash("sha256").update(canonical(parsedJson)).digest("hex");
};
// eslint-disable-next-line eslint/func-style -- Digest functions are used by the record schema after module initialization.
export function custodyPlanDigest(plan: CustodyPlan) {
  return custodyDigest(custodyPlanSchema.parse(plan));
}
// eslint-disable-next-line eslint/func-style -- Digest functions are used by the record schema after module initialization.
export function custodyActorDigest(actor: CanonicalSourceActor) {
  return custodyDigest(canonicalSourceActorSchema.parse(actor));
}
// eslint-disable-next-line eslint/func-style -- Digest functions are used by the record schema after module initialization.
export function custodyGrantDigest(grant: TrustedCustodySetupGrant) {
  return custodyDigest(trustedCustodySetupGrantSchema.parse(grant));
}
export const custodyRecordSchema = z
  .strictObject({
    approvalRef: id,
    attemptedAt: instant.optional(),
    fenceGeneration: z.number().int().nonnegative(),
    grantDigest: digest,
    grantRef: id,
    grantRevokedAt: instant.optional(),
    kind: z.literal(custodyKind),
    leaseExpiresAt: instant.optional(),
    leaseId: z.uuid().optional(),
    nonce: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .optional(),
    nonceConsumedAt: instant.optional(),
    nonceExpiresAt: instant.optional(),
    originalActor: canonicalSourceActorSchema,
    phase: z.enum([
      "reserved",
      "attempted",
      "secret-confirmed",
      "possession-pending",
      "possession-verified",
    ]),
    plan: custodyPlanSchema,
    planDigest: digest,
    receipt: custodyReceiptSchema.optional(),
    receivingDeploymentId: id.optional(),
    secret: custodySecretMetadataSchema.optional(),
    setupGrant: trustedCustodySetupGrantSchema,
    version: z.literal(1),
  })
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Each persisted phase independently enforces its required and forbidden checkpoint fields.
  .superRefine((record, context) => {
    const issue = (message: string) => {
      context.addIssue({ code: "custom", message });
    };
    // oxlint-disable-next-line sonarjs/expression-complexity -- All immutable custody bindings must match the approved record.
    if (
      [
        record.planDigest !== custodyPlanDigest(record.plan),
        record.plan.actorAuthorityDigest !== custodyActorDigest(record.originalActor),
        record.grantDigest !== custodyGrantDigest(record.setupGrant),
        record.grantRef !== record.setupGrant.grantRef,
        record.approvalRef !== record.setupGrant.approvalRef,
        record.setupGrant.operationRef !== record.plan.operationRef,
        record.setupGrant.approvedPlanDigest !== record.planDigest,
        record.setupGrant.ownerSessionId !== record.plan.ownerSessionId,
        custodyActorDigest(record.setupGrant.originalActor) !== record.plan.actorAuthorityDigest,
      ].some(Boolean)
    ) {
      issue("Custody identity mismatch.");
    }
    if ((record.leaseId === undefined) !== (record.leaseExpiresAt === undefined)) {
      issue("Incomplete custody lease.");
    }
    if (
      record.phase === "reserved" &&
      [
        record.attemptedAt,
        record.secret,
        record.receivingDeploymentId,
        record.nonce,
        record.nonceExpiresAt,
        record.nonceConsumedAt,
        record.receipt,
      ].some((v) => v !== undefined)
    ) {
      issue("Reserved checkpoint contains effects.");
    }
    if (record.phase !== "reserved" && record.attemptedAt === undefined) {
      issue("Missing attempted checkpoint.");
    }
    if (
      record.phase === "attempted" &&
      [
        record.secret,
        record.receivingDeploymentId,
        record.nonce,
        record.nonceExpiresAt,
        record.nonceConsumedAt,
        record.receipt,
      ].some((v) => v !== undefined)
    ) {
      issue("Attempted checkpoint contains unconfirmed effects.");
    }
    if (
      ["secret-confirmed", "possession-pending", "possession-verified"].includes(record.phase) &&
      record.secret === undefined
    ) {
      issue("Missing owned Secret row.");
    }
    if (
      record.secret !== undefined &&
      (record.secret.teamId !== record.plan.destination.teamId ||
        record.secret.projectId !== record.plan.destination.projectId)
    ) {
      issue("Secret scope mismatch.");
    }
    if (
      record.phase === "secret-confirmed" &&
      [
        record.receivingDeploymentId,
        record.nonce,
        record.nonceExpiresAt,
        record.nonceConsumedAt,
        record.receipt,
      ].some((v) => v !== undefined)
    ) {
      issue("Confirmed checkpoint contains premature possession.");
    }
    if (
      ["possession-pending", "possession-verified"].includes(record.phase) &&
      [
        record.receivingDeploymentId,
        record.nonce,
        record.nonceExpiresAt,
        record.leaseId,
        record.leaseExpiresAt,
      ].some((v) => v === undefined)
    ) {
      issue("Missing possession checkpoint.");
    }
    if (
      record.phase !== "possession-verified" &&
      (record.receipt !== undefined || record.nonceConsumedAt !== undefined)
    ) {
      issue("Unverified checkpoint contains receipt.");
    }
    if (record.phase === "possession-verified") {
      const { receipt } = record;
      // oxlint-disable-next-line sonarjs/expression-complexity -- The complete receipt must match this exact saved checkpoint.
      if (receipt === undefined) {
        issue("Missing verified receipt.");
        return;
      }
      if (
        [
          record.nonceConsumedAt === undefined,
          receipt.operationRef !== record.plan.operationRef,
          receipt.approvalRef !== record.approvalRef,
          receipt.planDigest !== record.planDigest,
          receipt.grantDigest !== record.grantDigest,
          receipt.providerRowId !== record.secret?.id,
          receipt.receivingDeploymentId !== record.receivingDeploymentId,
          receipt.verifiedAt !== record.nonceConsumedAt,
        ].some(Boolean)
      ) {
        issue("Verified receipt context mismatch.");
      }
    }
  });
export type CustodyRecord = z.infer<typeof custodyRecordSchema>;
export interface CustodyJournalRow {
  record: CustodyRecord;
  revision: number;
}
export interface CustodyJournalStore {
  read: (input: {
    authority: CanonicalSourceActor;
    operationRef: string;
  }) => Promise<CustodyJournalRow | undefined>;
  /** Only called under the fixed physical slot lock. Returns all authority tuples, safe metadata only. */
  findSlotClaims: (input: { plan: CustodyPlan }) => Promise<CustodyJournalRow[]>;
  reserve: (input: {
    authority: CanonicalSourceActor;
    record: CustodyRecord;
    now: Date;
  }) => Promise<CustodyJournalRow>;
  compareAndSet: (input: {
    authority: CanonicalSourceActor;
    operationRef: string;
    expectedRevision: number;
    record: CustodyRecord;
    now: Date;
  }) => Promise<CustodyJournalRow | undefined>;
}
export interface CustodyFence {
  operationRef: string;
  leaseId: string;
  fenceGeneration: number;
}
export type CustodyPhysicalLease = <T>(
  input: {
    lockKeys: readonly string[];
    initializeUnderLock?: () => Promise<void>;
    readCurrentFence: () => Promise<CustodyFence>;
  },
  run: (assertFence: () => Promise<void>) => Promise<T>,
) => Promise<T>;

export const custodySlotLockKey = (plan: CustodyPlan) =>
  JSON.stringify([
    "vercel-token-key-custody-slot-v1",
    plan.destination.teamId,
    plan.destination.projectId,
    "preview",
    null,
    [custodySecretKey, custodyVersionKey],
  ]);
export class CustodyUnavailableError extends Error {
  constructor() {
    super("Key custody is unavailable.");
    this.name = "CustodyUnavailableError";
  }
}
export class CustodyReconciliationRequiredError extends Error {
  constructor() {
    super("Key custody requires reconciliation.");
    this.name = "CustodyReconciliationRequiredError";
  }
}
export const assertCustodyGrant = (
  planInput: CustodyPlan,
  grantInput: TrustedCustodySetupGrant,
  actorInput: CanonicalSourceActor,
  now: number,
) => {
  const plan = custodyPlanSchema.parse(planInput);
  const grant = trustedCustodySetupGrantSchema.parse(grantInput);
  const actor = canonicalSourceActorSchema.parse(actorInput);
  // oxlint-disable-next-line sonarjs/expression-complexity -- Closed grant checks are independent authorization requirements.
  if (
    [
      grant.operationRef !== plan.operationRef,
      grant.approvedPlanDigest !== custodyPlanDigest(plan),
      grant.ownerSessionId !== plan.ownerSessionId,
      custodyActorDigest(actor) !== plan.actorAuthorityDigest,
      custodyActorDigest(grant.originalActor) !== plan.actorAuthorityDigest,
      Date.parse(grant.approvedAt) > now,
      Date.parse(grant.expiresAt) <= now,
      Date.parse(plan.approvalExpiresAt) <= now,
      Date.parse(grant.expiresAt) > Date.parse(plan.approvalExpiresAt),
    ].some(Boolean)
  ) {
    throw new CustodyUnavailableError();
  }
};
export const custodyPossessionContext = (record: CustodyRecord) => {
  if (
    [
      record.phase !== "possession-pending",
      record.nonce === undefined,
      record.nonceExpiresAt === undefined,
      record.receivingDeploymentId === undefined,
    ].some(Boolean)
  ) {
    throw new CustodyUnavailableError();
  }
  return canonical(
    z.json().parse({
      destination: record.plan.destination,
      domain: "autograph-active-v1-key-custody-possession-v1",
      fenceGeneration: record.fenceGeneration,
      grantDigest: record.grantDigest,
      keyVersion: "v1",
      nonce: record.nonce,
      nonceExpiresAt: record.nonceExpiresAt,
      operationRef: record.plan.operationRef,
      planDigest: record.planDigest,
      receivingDeploymentId: record.receivingDeploymentId,
      source: record.plan.source,
    }),
  );
};
export const createCustodyPossessionProof = (record: CustodyRecord, key: Buffer) => {
  if (key.length !== 32) {
    throw new CustodyUnavailableError();
  }
  return createHmac("sha256", key).update(custodyPossessionContext(record)).digest("hex");
};
export const verifyCustodyPossessionProof = (record: CustodyRecord, key: Buffer, proof: string) => {
  if (!digest.safeParse(proof).success) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(createCustodyPossessionProof(record, key), "hex"),
    Buffer.from(proof, "hex"),
  );
};

export interface CustodySourcePorts {
  currentSetup: () => Promise<{
    plan: CustodyPlan;
    grant: TrustedCustodySetupGrant;
    actor: CanonicalSourceActor;
  }>;
  store: CustodyJournalStore;
  physicalLease: CustodyPhysicalLease;
  secret: CustodySecretPort;
  readActiveKey: () => Promise<Buffer>;
  requestPossession: (operationRef: string, origin: string) => Promise<string>;
  now?: () => number;
}
export const createCustodySourceOperation =
  (ports: CustodySourcePorts) => async (operationRef: string) => {
    const now = ports.now ?? Date.now;
    const initial = await ports.currentSetup();
    const { plan, grant, actor } = initial;
    assertCustodyGrant(
      custodyPlanSchema.parse(plan),
      trustedCustodySetupGrantSchema.parse(grant),
      canonicalSourceActorSchema.parse(actor),
      now(),
    );
    if (operationRef !== plan.operationRef) {
      throw new CustodyUnavailableError();
    }
    const authority = actor;
    const identity = { authority, operationRef };
    const assertSetup = async () => {
      const current = await ports.currentSetup();
      assertCustodyGrant(current.plan, current.grant, current.actor, now());
      if (
        custodyPlanDigest(current.plan) !== custodyPlanDigest(plan) ||
        custodyGrantDigest(current.grant) !== custodyGrantDigest(grant) ||
        custodyActorDigest(current.actor) !== custodyActorDigest(actor)
      ) {
        throw new CustodyUnavailableError();
      }
    };
    const read = async () => {
      const row = await ports.store.read(identity);
      if (!row) {
        throw new CustodyUnavailableError();
      }
      custodyRecordSchema.parse(row.record);
      // oxlint-disable-next-line sonarjs/expression-complexity -- Reconciliation retains the exact approved identity tuple.
      if (
        [
          row.record.planDigest !== custodyPlanDigest(plan),
          row.record.grantDigest !== custodyGrantDigest(grant),
          row.record.grantRef !== grant.grantRef,
          row.record.approvalRef !== grant.approvalRef,
          row.record.grantRevokedAt !== undefined,
        ].some(Boolean)
      ) {
        throw new CustodyUnavailableError();
      }
      return row;
    };
    const prior = await ports.store.read(identity);
    if (prior?.record.phase === "possession-verified") {
      await assertSetup();
      const completed = await read();
      return custodyReceiptSchema.parse(completed.record.receipt);
    }
    let leaseId: string;
    const save = async (row: CustodyJournalRow, record: CustodyRecord) => {
      const saved = await ports.store.compareAndSet({
        ...identity,
        expectedRevision: row.revision,
        now: new Date(now()),
        record: custodyRecordSchema.parse(record),
      });
      if (!saved) {
        throw new CustodyUnavailableError();
      }
      return saved;
    };
    const initializeUnderLock = async () => {
      await assertSetup();
      const claims = await ports.store.findSlotClaims({ plan });
      if (
        claims.some(
          (row) =>
            row.record.plan.operationRef !== operationRef ||
            row.record.planDigest !== custodyPlanDigest(plan) ||
            row.record.grantDigest !== custodyGrantDigest(grant),
        )
      ) {
        throw new CustodyReconciliationRequiredError();
      }
      const row = await read();
      if (
        (row.record.leaseExpiresAt !== undefined &&
          Date.parse(row.record.leaseExpiresAt) > now()) ||
        (row.record.phase === "possession-pending" &&
          Date.parse(instant.parse(row.record.nonceExpiresAt)) > now())
      ) {
        throw new CustodyUnavailableError();
      }
      leaseId = randomUUID();
      const expires = Math.min(
        now() + 120_000,
        Date.parse(grant.expiresAt),
        Date.parse(plan.approvalExpiresAt),
      );
      const next: CustodyRecord = {
        ...row.record,
        fenceGeneration: row.record.fenceGeneration + 1,
        leaseExpiresAt: new Date(expires).toISOString(),
        leaseId,
      };
      if (next.phase === "possession-pending") {
        next.nonce = randomBytes(32).toString("base64url");
        next.nonceExpiresAt = new Date(expires).toISOString();
      }
      await save(row, next);
    };
    return await ports.physicalLease(
      {
        initializeUnderLock,
        lockKeys: [custodySlotLockKey(plan)],
        readCurrentFence: async () => {
          await assertSetup();
          const { record } = await read();
          if (
            record.leaseId !== leaseId ||
            record.leaseExpiresAt === undefined ||
            Date.parse(record.leaseExpiresAt) <= now()
          ) {
            throw new CustodyUnavailableError();
          }
          return { fenceGeneration: record.fenceGeneration, leaseId: record.leaseId, operationRef };
        },
      },
      async (assertFence) => {
        let row = await read();
        const existing = await ports.secret.inspect(row.record.secret);
        await assertFence();
        if (row.record.phase === "reserved") {
          if (existing !== undefined) {
            throw new CustodyReconciliationRequiredError();
          }
          const key = await ports.readActiveKey();
          try {
            row = await save(row, {
              ...row.record,
              attemptedAt: new Date(now()).toISOString(),
              phase: "attempted",
            });
            await assertFence();
            const secret = await ports.secret.create(key, assertFence);
            await assertFence();
            row = await save(row, { ...row.record, phase: "secret-confirmed", secret });
          } finally {
            key.fill(0);
          }
          const confirmed = await ports.secret.inspect(row.record.secret);
          if (
            confirmed === undefined ||
            confirmed.id !== custodySecretMetadataSchema.parse(row.record.secret).id
          ) {
            throw new CustodyReconciliationRequiredError();
          }
        } else if (row.record.phase === "attempted") {
          if (existing === undefined) {
            throw new CustodyReconciliationRequiredError();
          }
          row = await save(row, { ...row.record, phase: "secret-confirmed", secret: existing });
        } else if (existing === undefined || existing.id !== row.record.secret?.id) {
          throw new CustodyReconciliationRequiredError();
        }
        await assertFence();
        const receiver = await ports.secret.observeReceiver(
          instant.parse(row.record.attemptedAt),
          row.record.receivingDeploymentId,
        );
        if (receiver === undefined) {
          return { operationRef, phase: row.record.phase };
        }
        await assertFence();
        if (row.record.phase === "secret-confirmed") {
          row = await save(row, {
            ...row.record,
            nonce: randomBytes(32).toString("base64url"),
            nonceExpiresAt: row.record.leaseExpiresAt,
            phase: "possession-pending",
            receivingDeploymentId: receiver.deploymentId,
          });
        }
        if (row.record.receivingDeploymentId !== receiver.deploymentId) {
          throw new CustodyUnavailableError();
        }
        const proof = await ports.requestPossession(operationRef, receiver.origin);
        await assertFence();
        row = await read();
        if (
          row.record.phase !== "possession-pending" ||
          row.record.nonceConsumedAt !== undefined ||
          Date.parse(instant.parse(row.record.nonceExpiresAt)) <= now()
        ) {
          throw new CustodyUnavailableError();
        }
        const key = await ports.readActiveKey();
        try {
          if (!verifyCustodyPossessionProof(row.record, key, proof)) {
            throw new CustodyUnavailableError();
          }
        } finally {
          key.fill(0);
        }
        await assertFence();
        const verifiedAt = new Date(now()).toISOString();
        const receipt = custodyReceiptSchema.parse({
          approvalRef: grant.approvalRef,
          grantDigest: row.record.grantDigest,
          keyVersion: "v1",
          operationRef,
          planDigest: row.record.planDigest,
          possession: "verified",
          providerRowId: custodySecretMetadataSchema.parse(row.record.secret).id,
          receivingDeploymentId: row.record.receivingDeploymentId,
          verifiedAt,
        });
        await save(row, {
          ...row.record,
          nonceConsumedAt: verifiedAt,
          phase: "possession-verified",
          receipt,
        });
        return receipt;
      },
    );
  };
