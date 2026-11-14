import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { builderProvisioningJournals } from "../db/schema";
import type { HostedDatabase } from "../db/hosted-postgres";
import { privateOperatorApprovalObservationSchema } from "../eve/private-operator-approval-observation";
import type {
  PrivateOperatorApprovalCapture,
  PrivateOperatorApprovalObservation,
} from "../eve/private-operator-approval-observation";
import type { OperatorOwnerContext } from "./hosted-operator-contract";

const recordSchema = z.strictObject({
  kind: z.string().min(1),
  version: z.literal(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  observation: privateOperatorApprovalObservationSchema,
});
/** Durable read cursor only. Neither this row nor a prior approved call grants consent. */
export const createPostgresOperatorApprovalCheckpoint = (input: {
  database: HostedDatabase;
  kind: string;
  key: string;
  request: PrivateOperatorApprovalCapture["request"];
  owner: OperatorOwnerContext;
  callId?: string;
  assertCurrentOwner: () => Promise<void>;
  unavailable: () => Error;
}) => {
  const { unavailable } = input;
  const digest = input.request.planDigest;
  const hex = createHash("sha256").update(input.key).digest("hex");
  const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const { authority } = input.owner;
  const predicate = and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, requestId),
    sql`${builderProvisioningJournals.record} ->> 'kind' = ${input.kind}`,
  );
  const assertCapture = (capture: PrivateOperatorApprovalCapture) => {
    if (
      capture.ownerUserId !== authority.ownerUserId ||
      !isDeepStrictEqual(capture.request, input.request) ||
      capture.entries.some((entry) => input.callId !== undefined && entry.callId !== input.callId)
    ) {
      throw unavailable();
    }
  };
  let expected: { revision: number; observation: PrivateOperatorApprovalObservation } | undefined;
  const read = async () => {
    await input.assertCurrentOwner();
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate)
      .limit(1);
    const row = rows.at(0);
    await input.assertCurrentOwner();
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing durable checkpoint explicitly starts history at zero.
      return undefined;
    }
    const record = recordSchema.parse(row.record);
    if (
      row.requestDigest !== digest ||
      record.kind !== input.kind ||
      record.planDigest !== digest
    ) {
      throw unavailable();
    }
    assertCapture(record.observation.capture);
    expected = { revision: row.revision, observation: record.observation };
    return structuredClone(record.observation);
  };
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Bound intent, adapter cursor, monotone settlements and CAS are one atomic checkpoint guard.
  const save = async (state: PrivateOperatorApprovalObservation) => {
    const parsed = privateOperatorApprovalObservationSchema.parse(state);
    if (
      parsed.adapterSessionId !== input.owner.adapterSessionId ||
      parsed.adapterGeneration !== input.owner.adapterGeneration
    ) {
      throw unavailable();
    }
    assertCapture(parsed.capture);
    await input.assertCurrentOwner();
    const previous = expected;
    if (previous && isDeepStrictEqual(previous.observation, parsed)) {
      return;
    }
    if (previous) {
      const prior = previous.observation;
      if (
        prior.adapterSessionId === parsed.adapterSessionId &&
        prior.adapterGeneration === parsed.adapterGeneration &&
        parsed.nextNativeIndex < prior.nextNativeIndex
      ) {
        throw unavailable();
      }
      // No cursor update can erase an authenticated cancellation or a completed settlement.
      for (const entry of prior.capture.entries) {
        if (entry.cancelled || entry.completedApproved || entry.completedCancelled) {
          const current = parsed.capture.entries.find(
            (candidate) =>
              candidate.requestId === entry.requestId && candidate.callId === entry.callId,
          );
          if (
            // oxlint-disable-next-line sonarjs/expression-complexity -- No completed grant or authenticated cancellation can regress.
            !current ||
            (entry.cancelled && !current.cancelled) ||
            (entry.completedApproved && !current.completedApproved) ||
            (entry.completedCancelled && !current.completedCancelled)
          ) {
            throw unavailable();
          }
        }
      }
    }
    const record = recordSchema.parse({
      kind: input.kind,
      version: 1,
      planDigest: digest,
      observation: parsed,
    });
    const now = new Date();
    const rows = previous
      ? await input.database
          .update(builderProvisioningJournals)
          .set({ record, revision: previous.revision + 1, updatedAt: now })
          .where(and(predicate, eq(builderProvisioningJournals.revision, previous.revision)))
          .returning({ revision: builderProvisioningJournals.revision })
      : await input.database
          .insert(builderProvisioningJournals)
          .values({
            ...authority,
            requestId,
            requestDigest: digest,
            record,
            revision: 1,
            state: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ revision: builderProvisioningJournals.revision });
    if (rows.length !== 1) {
      throw unavailable();
    }
    expected = { revision: rows[0].revision, observation: structuredClone(parsed) };
    await input.assertCurrentOwner();
  };
  return { read, save };
};
