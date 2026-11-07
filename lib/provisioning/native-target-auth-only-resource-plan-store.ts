import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle requires the complete schema type.
import type * as databaseSchema from "../db/schema";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import { nativeTargetAuthOnlyResourceApprovalPlanSchema } from "./native-target-auth-only-maintenance";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const requestIdFor = (value: string) => {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const recordSchema = z.strictObject({
  kind: z.literal("native-target-auth-only-resource-plan"),
  version: z.literal(1),
  stage: z.literal("retained"),
  authOnlyPlanDigest: digest,
  resourcePlanDigest: digest,
  resourcePlanBase64: z.string().min(1),
  workerContexts: z.strictObject({ resources: digest.optional(), auth: digest.optional() }),
});
type Database = PostgresJsDatabase<typeof databaseSchema>;

export const nativeTargetAuthOnlyResourcePlanDigest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Immutable owner/session-scoped raw bytes for the separately approved Auth resource effect. */
export const createNativeTargetAuthOnlyResourcePlanStore = (input: {
  database: Database;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}) => {
  const read = async (
    context: OperatorArtifactContext,
    authOnlyPlanDigest: string,
    resourcePlanDigest: string,
  ) => {
    const authority = hostedTenantAuthoritySchema.parse(context.authority);
    await input.assertCurrentOwner(context);
    const requestId = requestIdFor(resourcePlanDigest);
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(
          eq(builderProvisioningJournals.issuer, authority.issuer),
          eq(builderProvisioningJournals.audience, authority.audience),
          eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
          eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
          eq(builderProvisioningJournals.requestId, requestId),
          eq(builderProvisioningJournals.requestDigest, resourcePlanDigest),
          sql`${builderProvisioningJournals.record} ->> 'kind' = 'native-target-auth-only-resource-plan'`,
        ),
      )
      .limit(1);
    await input.assertCurrentOwner(context);
    const row = rows[0];
    if (row === undefined) return undefined;
    const record = recordSchema.parse(row.record);
    if (
      row.state !== "settled" ||
      record.authOnlyPlanDigest !== authOnlyPlanDigest ||
      record.resourcePlanDigest !== resourcePlanDigest
    )
      throw new Error("native_target_auth_only_resource_plan_mismatch");
    const bytes = Buffer.from(record.resourcePlanBase64, "base64");
    if (
      bytes.toString("base64") !== record.resourcePlanBase64 ||
      nativeTargetAuthOnlyResourcePlanDigest(bytes) !== resourcePlanDigest
    )
      throw new Error("native_target_auth_only_resource_plan_mismatch");
    const parsed = nativeTargetAuthOnlyResourceApprovalPlanSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (
      parsed.authOnlyPlanDigest !== authOnlyPlanDigest ||
      parsed.target.appId !== context.target.appId ||
      parsed.target.sessionId !== context.target.sessionId
    )
      throw new Error("native_target_auth_only_resource_plan_mismatch");
    return {
      bytes: Buffer.from(bytes),
      plan: parsed,
      revision: row.revision,
      workerContexts: record.workerContexts,
    };
  };
  return {
    read,
    async writeIfAbsent(
      context: OperatorArtifactContext,
      authOnlyPlanDigest: string,
      rawBytes: Buffer,
    ) {
      const bytes = Buffer.from(rawBytes);
      const resourcePlanDigest = nativeTargetAuthOnlyResourcePlanDigest(bytes);
      const parsed = nativeTargetAuthOnlyResourceApprovalPlanSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      if (
        parsed.authOnlyPlanDigest !== authOnlyPlanDigest ||
        parsed.target.appId !== context.target.appId ||
        parsed.target.sessionId !== context.target.sessionId
      )
        throw new Error("native_target_auth_only_resource_plan_mismatch");
      const authority = hostedTenantAuthoritySchema.parse(context.authority);
      const requestId = requestIdFor(resourcePlanDigest);
      const record = recordSchema.parse({
        kind: "native-target-auth-only-resource-plan",
        version: 1,
        stage: "retained",
        authOnlyPlanDigest,
        resourcePlanDigest,
        resourcePlanBase64: bytes.toString("base64"),
        workerContexts: {},
      });
      await input.assertCurrentOwner(context);
      await input.database
        .insert(builderProvisioningJournals)
        .values({
          ...authority,
          requestId,
          requestDigest: resourcePlanDigest,
          record,
          revision: 1,
          state: "settled",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
      await input.assertCurrentOwner(context);
      const retained = await read(context, authOnlyPlanDigest, resourcePlanDigest);
      if (
        retained === undefined ||
        !retained.bytes.equals(bytes) ||
        !isDeepStrictEqual(retained.plan, parsed)
      )
        throw new Error("native_target_auth_only_resource_plan_conflict");
      return { resourcePlanDigest, bytes: Buffer.from(retained.bytes), plan: retained.plan };
    },
    async bindWorkerContext(
      context: OperatorArtifactContext,
      authOnlyPlanDigest: string,
      resourcePlanDigest: string,
      stage: "resources" | "auth",
      contextDigest: string,
    ) {
      const retained = await read(context, authOnlyPlanDigest, resourcePlanDigest);
      if (retained === undefined) throw new Error("native_target_auth_only_resource_plan_missing");
      const authority = hostedTenantAuthoritySchema.parse(context.authority);
      const previous = retained.workerContexts[stage];
      if (previous !== undefined && previous !== contextDigest)
        throw new Error("native_target_auth_only_worker_context_conflict");
      if (previous === contextDigest) return;
      const rowPredicate = and(
        eq(builderProvisioningJournals.issuer, authority.issuer),
        eq(builderProvisioningJournals.audience, authority.audience),
        eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
        eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
        eq(builderProvisioningJournals.requestId, requestIdFor(resourcePlanDigest)),
        eq(builderProvisioningJournals.revision, retained.revision),
        sql`${builderProvisioningJournals.record} ->> 'kind' = 'native-target-auth-only-resource-plan'`,
      );
      const next = recordSchema.parse({
        kind: "native-target-auth-only-resource-plan",
        version: 1,
        stage: "retained",
        authOnlyPlanDigest,
        resourcePlanDigest,
        resourcePlanBase64: retained.bytes.toString("base64"),
        workerContexts: { ...retained.workerContexts, [stage]: digest.parse(contextDigest) },
      });
      await input.assertCurrentOwner(context);
      const rows = await input.database
        .update(builderProvisioningJournals)
        .set({ record: next, revision: retained.revision + 1, updatedAt: new Date() })
        .where(rowPredicate)
        .returning();
      if (rows[0] === undefined) throw new Error("native_target_auth_only_resource_plan_conflict");
      await input.assertCurrentOwner(context);
    },
  };
};
