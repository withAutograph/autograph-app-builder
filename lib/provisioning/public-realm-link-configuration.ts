import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { builderProvisioningJournals } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  encryptVercelToken,
  decryptVersionedVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  hostedOperatorRecordSchema,
  retainedOperatorAuthSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { HostedOperatorRecord, RetainedOperatorAuth } from "./hosted-operator-contract";
import { publicRealmEnrollmentSchema, publicRealmResourceSchema } from "./public-realm-enrollment";

const id = z.string().min(1);
const origin = z
  .url()
  .refine((value) => new URL(value).origin === value && new URL(value).protocol === "https:");
const attester = z.object({ issuer: z.url(), audience: z.url(), projectId: id, ownerId: id });
const sender = attester.extend({ environment: z.literal("production"), subject: id });
export const publicRealmLinkConfigurationSchema = z.strictObject({
  publicEnrollment: publicRealmEnrollmentSchema,
  browserOrigin: origin,
  builderCallbackOrigin: origin,
  builderCallbackPath: z.literal("/api/hosted-operator/realm-identity"),
  operatorOrigin: origin,
  identityHandoff: z.strictObject({ sender }),
  browserSessionCapture: z.strictObject({
    path: z.literal("/api/hosted-operator/realm-browser-session"),
    sender,
  }),
  readonlyAttesters: z.strictObject({
    builderProduction: attester.extend({ environment: z.literal("production") }),
    operatorPreview: attester.extend({ environment: z.literal("preview") }),
  }),
});
/** A metadata projection from the already validated deployment-owned configuration. */
export interface PublicRealmLinkSourceConfiguration {
  teamId: string;
  gateway: { projectId: string };
  builderCallbackOrigin: string;
  operator: { origin: string };
  workloadPolicy: z.infer<typeof attester> & {
    environment: "development" | "preview" | "production";
    subject?: string;
  };
  nativeNeon: {
    configuration: {
      operator: z.infer<typeof attester> & { environment: "preview" | "production" };
    };
  };
  standardRuntime?: { publicRealmWorkload?: z.infer<typeof sender> };
}
const sealed = z.strictObject({ encryptedToken: id, keyVersion: id, tokenIv: id, tokenTag: id });
const savedSchema = z.strictObject({
  kind: z.literal("public-realm-enrollment-v1"),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  enrollment: publicRealmEnrollmentSchema,
  sealedConfiguration: sealed,
});
const unavailable = () => new Error("public_realm_enrollment_unavailable");
type Database = ReturnType<typeof openHostedPostgresDatabase>;
interface Owner {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
  sessionId: string;
}
const ownerPredicate = (authority: Owner["authority"]) =>
  and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    sql`${builderProvisioningJournals.record}->>'kind' = 'public-realm-enrollment-v1'`,
  );
const open = (record: z.infer<typeof savedSchema>, keyring: VercelTokenKeyringConfig) => {
  const configuration = publicRealmLinkConfigurationSchema.parse(
    JSON.parse(
      decryptVersionedVercelToken({
        ...record.sealedConfiguration,
        config: keyring,
        associatedData: `public-realm-enrollment-v1:${record.scopeDigest}`,
      }),
    ),
  );
  if (!isDeepStrictEqual(configuration.publicEnrollment, record.enrollment)) {
    throw unavailable();
  }
  return configuration;
};
/** Read-only enrollment metadata; READY public release and genuine approval verification remain mandatory at callback resolution. */
export const readPublicRealmLinkConfiguration = async (input: {
  database: Database;
  keyring: VercelTokenKeyringConfig;
  authority: Owner["authority"];
  enrollmentRef: string;
  assertCurrentOwner: () => Promise<void>;
}) => {
  await input.assertCurrentOwner();
  const ref = z.uuid().parse(input.enrollmentRef);
  const rows = await input.database
    .select()
    .from(builderProvisioningJournals)
    .where(
      and(
        ownerPredicate(input.authority),
        sql`${builderProvisioningJournals.record}->'enrollment'->>'enrollmentRef' = ${ref}`,
      ),
    )
    .limit(2);
  await input.assertCurrentOwner();
  if (rows.length !== 1 || rows[0] === undefined) {
    throw unavailable();
  }
  const record = savedSchema.parse(rows[0].record);
  if (
    !isDeepStrictEqual(record.enrollment.authority, input.authority) ||
    rows[0].requestDigest !== record.scopeDigest
  ) {
    throw unavailable();
  }
  return open(record, input.keyring);
};
/** Server-only fresh normal setup facts. No public/model input can create provider or membership authority here. */
export const resolvePublicRealmEnrollment = async (input: {
  database: Database;
  keyring: VercelTokenKeyringConfig;
  configuration: PublicRealmLinkSourceConfiguration;
  owner: Owner;
  originalSetup: HostedOperatorRecord | RetainedOperatorAuth;
  authResource: z.infer<typeof publicRealmResourceSchema>;
  publicOrigin: string;
  assertCurrentOwner: () => Promise<void>;
}) => {
  await input.assertCurrentOwner();
  const original = z
    .union([hostedOperatorRecordSchema, retainedOperatorAuthSchema])
    .parse(input.originalSetup);
  const authority = hostedTenantAuthoritySchema.parse(input.owner.authority);
  const resource = publicRealmResourceSchema.parse(input.authResource);
  const { configuration } = input;
  const workload = sender.parse(
    z.object({ standardRuntime: z.object({ publicRealmWorkload: sender }) }).parse(configuration)
      .standardRuntime.publicRealmWorkload,
  );
  const scope = {
    authority,
    appId: input.owner.appId,
    ownerSessionId: input.owner.sessionId,
    publicOrigin: origin.parse(input.publicOrigin),
    project: {
      projectId: workload.projectId,
      ownerId: workload.ownerId,
      environment: "production" as const,
    },
    sourceBootstrap: {
      operationRef: original.operationRef,
      planDigest: original.planDigest,
      authResourceId: original.plan.authDatabase.resourceId,
    },
    resource,
  };
  const matches = [
    original.planDigest === operatorPlanDigest(original.plan),
    original.approvalId !== undefined,
    !("pendingEffectId" in original) || original.pendingEffectId === undefined,
    !("pendingEffectAttempt" in original) || original.pendingEffectAttempt === undefined,
    original.plan.neon.source === "synthetic-only",
    original.plan.deploymentBoundary?.composition === "single-project-services",
    original.plan.publicGateway?.projectId === workload.projectId,
    original.plan.publicGateway?.origin === scope.publicOrigin,
    original.plan.selection.appId === scope.appId,
    original.plan.selection.projectId === workload.projectId,
    original.plan.selection.sessionId === scope.ownerSessionId,
    isDeepStrictEqual(original.plan.deploymentBoundary?.authority, authority),
    workload.ownerId === configuration.teamId,
    workload.projectId === configuration.gateway.projectId,
    original.plan.authDatabase.database === resource.database,
    original.plan.authDatabase.runtimeRole === resource.runtimeRole,
    original.plan.authDatabase.migratorRole === resource.migratorRole,
    original.plan.neon.endpoint === resource.hostname,
    original.plan.neon.projectId === resource.neon.projectId,
    original.plan.neon.branchId === resource.neon.branchId,
  ].every(Boolean);
  if (!matches) {
    throw unavailable();
  }
  const readonlyAttesters = {
    builderProduction: attester
      .extend({ environment: z.literal("production") })
      .parse(configuration.workloadPolicy),
    operatorPreview: attester
      .extend({ environment: z.literal("preview") })
      .parse(configuration.nativeNeon.configuration.operator),
  };
  const context = {
    ...scope,
    workload,
    readonlyAttesters,
    builderCallbackOrigin: origin.parse(configuration.builderCallbackOrigin),
    operatorOrigin: origin.parse(configuration.operator.origin),
  };
  const digest = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const read = async () => {
    await input.assertCurrentOwner();
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(and(ownerPredicate(authority), eq(builderProvisioningJournals.requestId, requestId)))
      .limit(1);
    await input.assertCurrentOwner();
    const row = rows[0];
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing enrollment metadata is an explicit optional result, not an activated realm.
      return undefined;
    }
    const record = savedSchema.parse(row.record);
    if (
      record.scopeDigest !== digest ||
      row.requestDigest !== digest ||
      !isDeepStrictEqual(
        publicRealmEnrollmentSchema
          .omit({ enrollmentRef: true, kind: true, version: true })
          .strip()
          .parse(record.enrollment),
        scope,
      )
    ) {
      throw unavailable();
    }
    return open(record, input.keyring);
  };
  let linkConfiguration = await read();
  if (linkConfiguration === undefined) {
    const enrollment = publicRealmEnrollmentSchema.parse({
      ...scope,
      kind: "public-isolated-realm-v1",
      version: 1,
      enrollmentRef: randomUUID(),
    });
    const proposed = publicRealmLinkConfigurationSchema.parse({
      publicEnrollment: enrollment,
      browserOrigin: scope.publicOrigin,
      builderCallbackOrigin: context.builderCallbackOrigin,
      builderCallbackPath: "/api/hosted-operator/realm-identity",
      operatorOrigin: context.operatorOrigin,
      identityHandoff: { sender: workload },
      browserSessionCapture: {
        path: "/api/hosted-operator/realm-browser-session",
        sender: workload,
      },
      readonlyAttesters,
    });
    const sealedConfiguration = {
      ...encryptVercelToken({
        key: input.keyring.tokenKey,
        token: JSON.stringify(proposed),
        associatedData: `public-realm-enrollment-v1:${digest}`,
      }),
      keyVersion: input.keyring.tokenKeyVersion,
    };
    await input.assertCurrentOwner();
    const now = new Date();
    await input.database
      .insert(builderProvisioningJournals)
      .values({
        ...authority,
        requestId,
        requestDigest: digest,
        state: "pending",
        revision: 1,
        record: savedSchema.parse({
          kind: "public-realm-enrollment-v1",
          scopeDigest: digest,
          enrollment,
          sealedConfiguration,
        }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await input.assertCurrentOwner();
    linkConfiguration = await read();
  }
  if (linkConfiguration === undefined) {
    throw unavailable();
  }
  return { enrollmentRef: linkConfiguration.publicEnrollment.enrollmentRef, linkConfiguration };
};
