import { z } from "zod";
import {
  custodyDigest,
  custodyRecordSchema,
  custodySlotLockKey,
  isRetiredUnattemptedReservation,
  isUnattemptedUnfencedReservation,
  assertCustodyGrant,
  CustodyUnavailableError,
  CustodyReconciliationRequiredError,
} from "./vercel-token-key-custody";
import type {
  CustodyJournalStore,
  CustodyPhysicalLease,
  CustodyRecord,
} from "./vercel-token-key-custody";

/** Consumed only by the private administrator entrypoint, never by either HTTP handler. */
export const custodyEnrollmentRequestSchema = z
  .strictObject({
    action: z.literal("enroll-active-v1-key-custody"),
    record: custodyRecordSchema,
    version: z.literal(1),
  })
  .refine(
    ({ record }) =>
      record.phase === "reserved" &&
      record.fenceGeneration === 0 &&
      record.leaseId === undefined &&
      record.grantRevokedAt === undefined,
  );
export const custodyEnrollmentDigest = (input: z.infer<typeof custodyEnrollmentRequestSchema>) =>
  custodyDigest(custodyEnrollmentRequestSchema.parse(input));
export const enrollCustodyGrant = async (input: {
  request: z.infer<typeof custodyEnrollmentRequestSchema>;
  confirmationDigest: string;
  store: CustodyJournalStore;
  physicalLease: CustodyPhysicalLease;
  assertOriginalOwner: (record: CustodyRecord) => Promise<void>;
  now?: () => number;
}) => {
  const request = custodyEnrollmentRequestSchema.parse(input.request);
  const { record } = request;
  const now = input.now ?? Date.now;
  if (input.confirmationDigest !== custodyEnrollmentDigest(request)) {
    throw new CustodyUnavailableError();
  }
  const assertAuthority = async () => {
    assertCustodyGrant(record.plan, record.setupGrant, record.originalActor, now());
    await input.assertOriginalOwner(record);
  };
  // This private setup transaction reserves metadata only. No injected key or provider credential is read.
  return await input.physicalLease(
    {
      lockKeys: [custodySlotLockKey(record.plan)],
      readCurrentFence: async () => {
        await assertAuthority();
        return {
          fenceGeneration: 0,
          leaseId: record.plan.operationRef,
          operationRef: record.plan.operationRef,
        };
      },
    },
    async (assertFence) => {
      await assertFence();
      const claims = await input.store.findSlotClaims({ plan: record.plan });
      if (claims.some((claim) => custodyDigest(claim.record) !== custodyDigest(record))) {
        throw new CustodyReconciliationRequiredError();
      }
      await assertFence();
      const row = await input.store.reserve({
        authority: record.originalActor,
        now: new Date(now()),
        record,
      });
      if (custodyDigest(row.record) !== custodyDigest(record)) {
        throw new CustodyReconciliationRequiredError();
      }
      return {
        approvalRef: record.approvalRef,
        enrolled: true as const,
        grantDigest: record.grantDigest,
        grantRef: record.grantRef,
        operationRef: record.plan.operationRef,
        planDigest: record.planDigest,
      };
    },
  );
};

/** A reviewed, exact revision snapshot for the private admin-only reservation retirement. */
export const custodyRetirementRequestSchema = z
  .strictObject({
    action: z.literal("retire-unattempted-reserved-v1-key-custody"),
    expectedRevision: z.number().int().positive(),
    record: custodyRecordSchema,
    version: z.literal(1),
  })
  .refine(({ record }) => isUnattemptedUnfencedReservation(record));
export const custodyRetirementDigest = (input: z.infer<typeof custodyRetirementRequestSchema>) =>
  custodyDigest(custodyRetirementRequestSchema.parse(input));

/** Retire only the exact unattempted reservation, under its global slot lock and current owner. */
export const retireCustodyReservation = async (input: {
  request: z.infer<typeof custodyRetirementRequestSchema>;
  confirmationDigest: string;
  store: CustodyJournalStore;
  physicalLease: CustodyPhysicalLease;
  assertOriginalOwner: (record: CustodyRecord) => Promise<void>;
  now?: () => number;
}) => {
  const request = custodyRetirementRequestSchema.parse(input.request);
  const { record, expectedRevision } = request;
  const expectedRecordDigest = custodyDigest(record);
  const now = input.now ?? Date.now;
  if (input.confirmationDigest !== custodyRetirementDigest(request)) {
    throw new CustodyUnavailableError();
  }
  const assertExactReservation = async () => {
    const current = await input.store.read({
      authority: record.originalActor,
      operationRef: record.plan.operationRef,
    });
    if (
      current === undefined ||
      current.revision !== expectedRevision ||
      custodyDigest(current.record) !== expectedRecordDigest ||
      !isUnattemptedUnfencedReservation(current.record)
    ) {
      throw new CustodyReconciliationRequiredError();
    }
    return current;
  };
  const beforeLock = await assertExactReservation();
  return await input.physicalLease(
    {
      lockKeys: [custodySlotLockKey(record.plan)],
      readCurrentFence: async () => {
        await assertExactReservation();
        await input.assertOriginalOwner(record);
        return {
          fenceGeneration: beforeLock.record.fenceGeneration,
          leaseId: record.plan.operationRef,
          operationRef: record.plan.operationRef,
        };
      },
    },
    async (assertFence) => {
      await assertFence();
      const retired = await input.store.retireReserved({
        authority: record.originalActor,
        expectedRecordDigest,
        expectedRevision,
        operationRef: record.plan.operationRef,
        revokedAt: new Date(now()),
      });
      if (
        retired === undefined ||
        retired.revision !== expectedRevision + 1 ||
        !isRetiredUnattemptedReservation(retired.record)
      ) {
        throw new CustodyReconciliationRequiredError();
      }
      return {
        operationRef: record.plan.operationRef,
        retired: true as const,
        revision: retired.revision,
      };
    },
  );
};
