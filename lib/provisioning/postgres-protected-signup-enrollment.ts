import { and, eq, sql } from "drizzle-orm";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  signupEnrollmentIdentity,
  signupEnrollmentPolicySchema,
  signupEnrollmentRecordSchema,
  signupEnrollmentScopeSchema,
} from "./protected-signup-enrollment";
import type { SignupEnrollmentStore } from "./protected-signup-enrollment";

type Database = ReturnType<typeof openHostedPostgresDatabase>;
type Key = Parameters<SignupEnrollmentStore["read"]>[0];

const predicate = (key: Key) => {
  const authority = hostedTenantAuthoritySchema.parse(key.authority);
  const { requestId, digest } = signupEnrollmentIdentity(key.scope);
  return and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, requestId),
    eq(builderProvisioningJournals.requestDigest, digest),
    sql`${builderProvisioningJournals.record} ->> 'kind' = 'protected-signup-enrollment'`,
  );
};

const parseRow = (row: typeof builderProvisioningJournals.$inferSelect) => ({
  record: signupEnrollmentRecordSchema.parse(row.record),
  revision: row.revision,
});

/** Same journal and physical fence sequence as named-actor grants and revocation. */
export const createPostgresProtectedSignupEnrollmentStore = (
  database: Database,
): SignupEnrollmentStore => {
  const read: SignupEnrollmentStore["read"] = async (key) => {
    const [row] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(key))
      .limit(1);
    return row === undefined ? undefined : parseRow(row);
  };

  return {
    read,
    async reserve(input) {
      const scope = signupEnrollmentScopeSchema.parse(input.scope);
      const policy = signupEnrollmentPolicySchema.parse(input.policy);
      const { requestId, digest } = signupEnrollmentIdentity(scope);
      const partial = {
        version: 1,
        kind: "protected-signup-enrollment",
        scope,
        policy,
        state: "pending",
      };
      const [created] = await database
        .insert(builderProvisioningJournals)
        .values({
          ...hostedTenantAuthoritySchema.parse(input.authority),
          requestId,
          requestDigest: digest,
          createdAt: input.now,
          updatedAt: input.now,
          state: "pending",
          record: sql`${JSON.stringify(partial)}::jsonb || jsonb_build_object(
          'generation', nextval('public.builder_protected_access_fence_generation_seq'::regclass)
        )`,
        })
        .onConflictDoNothing()
        .returning();
      const row = created === undefined ? await read(input) : parseRow(created);
      if (row === undefined) {
        throw new Error("Signup enrollment ownership is unavailable.");
      }
      return row;
    },
    async compareAndSet(input) {
      const record = signupEnrollmentRecordSchema.parse(input.record);
      if (
        signupEnrollmentIdentity(record.scope).digest !==
        signupEnrollmentIdentity(input.scope).digest
      ) {
        throw new Error("Signup enrollment scope cannot change.");
      }
      const [row] = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: input.expectedRevision + 1,
          state: record.state === "pending" ? "pending" : "settled",
          updatedAt: input.now,
        })
        .where(
          and(
            predicate(input),
            eq(builderProvisioningJournals.revision, input.expectedRevision),
            sql`${builderProvisioningJournals.record} ->> 'generation' = ${String(record.generation)}`,
            sql`${builderProvisioningJournals.record} -> 'policy' = ${JSON.stringify(record.policy)}::jsonb`,
            sql`${builderProvisioningJournals.record} ->> 'state' = 'pending'`,
          ),
        )
        .returning();
      return row === undefined ? undefined : parseRow(row);
    },
  };
};
