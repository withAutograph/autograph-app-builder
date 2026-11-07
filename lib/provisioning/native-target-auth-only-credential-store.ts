import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { builderProvisioningJournals } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- the journal adapter requires the complete schema type.
import type * as databaseSchema from "../db/schema";
import {
  createHostedOperatorAuthOnlyCredentials,
  authOnlyCredentialContextDigest,
  authOnlyCredentialContextSchema,
  authOnlyCredentialRecordSchema,
} from "./hosted-operator-auth-only-credentials";
import type {
  AuthOnlyCredentialStore,
  AuthOnlyCredentialStorageKey,
  AuthOnlyCredentialContext,
} from "./hosted-operator-auth-only-credentials";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyApprovalSchema } from "./native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "./native-target-auth-only-dispatch";
import { nativeTargetAuthOnlyAuthorityDigest } from "./native-target-auth-only-planner";
import { resolveNativeTargetResourceProfile } from "./native-target-resource-profile";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";

type Database = PostgresJsDatabase<typeof databaseSchema>;
const credentialKind = "native-target-auth-only-credentials-v1";
const storedRecordSchema = authOnlyCredentialRecordSchema.extend({ stage: z.literal("sealed") });

/** Map a context digest to a stable RFC 4122 UUID for the shared journal primary key. */
const requestIdFor = (contextDigest: string) => {
  const bytes = Buffer.from(createHash("sha256").update(contextDigest).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const validateKey = (key: AuthOnlyCredentialStorageKey) => {
  const context = authOnlyCredentialContextSchema.parse(key.context);
  const contextDigest = z.string().regex(/^[a-f0-9]{64}$/u).parse(key.contextDigest);
  if (authOnlyCredentialContextDigest(context) !== contextDigest) {
    throw new Error("native_target_auth_only_credential_context_mismatch");
  }
  return { context, contextDigest, requestId: requestIdFor(contextDigest) };
};

/** Encrypted records only; deterministic UUID plus INSERT ON CONFLICT gives write-if-absent semantics. */
export const createPostgresNativeTargetAuthOnlyCredentialStore = (
  database: Database,
): AuthOnlyCredentialStore => {
  const predicate = (key: AuthOnlyCredentialStorageKey) => {
    const selected = validateKey(key);
    return and(
      eq(builderProvisioningJournals.issuer, selected.context.authority.issuer),
      eq(builderProvisioningJournals.audience, selected.context.authority.audience),
      eq(builderProvisioningJournals.workspaceId, selected.context.authority.workspaceId),
      eq(builderProvisioningJournals.ownerUserId, selected.context.authority.ownerUserId),
      eq(builderProvisioningJournals.requestId, selected.requestId),
      eq(builderProvisioningJournals.requestDigest, selected.contextDigest),
      sql`${builderProvisioningJournals.record} ->> 'kind' = ${credentialKind}`,
    );
  };
  const parseRow = (row: typeof builderProvisioningJournals.$inferSelect) => {
    const { stage: _stage, ...record } = storedRecordSchema.parse(row.record);
    const selected = validateKey({
      context: record.context,
      contextDigest: authOnlyCredentialContextDigest(record.context),
    });
    if (
      row.requestId !== selected.requestId ||
      row.requestDigest !== selected.contextDigest ||
      row.state !== "settled" ||
      !isDeepStrictEqual(
        hostedTenantAuthoritySchema.parse({
          issuer: row.issuer,
          audience: row.audience,
          workspaceId: row.workspaceId,
          ownerUserId: row.ownerUserId,
        }),
        record.context.authority,
      )
    ) {
      throw new Error("native_target_auth_only_credential_record_mismatch");
    }
    return record;
  };
  const read = async (key: AuthOnlyCredentialStorageKey) => {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(key))
      .limit(1);
    return rows[0] === undefined ? undefined : parseRow(rows[0]);
  };
  return {
    read,
    async writeIfAbsent(key, rawRecord) {
      const selected = validateKey(key);
      const record = authOnlyCredentialRecordSchema.parse(rawRecord);
      if (!isDeepStrictEqual(record.context, selected.context)) {
        throw new Error("native_target_auth_only_credential_context_mismatch");
      }
      const now = new Date();
      const rows = await database
        .insert(builderProvisioningJournals)
        .values({
          ...selected.context.authority,
          requestId: selected.requestId,
          requestDigest: selected.contextDigest,
          record: { ...record, stage: "sealed" },
          revision: 1,
          state: "settled",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (rows[0] !== undefined) {
        parseRow(rows[0]);
        return "written";
      }
      const existing = await read(key);
      if (existing === undefined) {
        throw new Error("native_target_auth_only_credential_write_uncertain");
      }
      return "exists";
    },
  };
};

export const nativeTargetAuthOnlyCredentialJournalRequestId = requestIdFor;
export const nativeTargetAuthOnlyCredentialOperationRef = (plan: NativeTargetAuthOnlyPlan) =>
  requestIdFor(nativeTargetAuthOnlyPlanDigest(plan));

export const nativeTargetAuthOnlyCredentialContextForPlan = (input: {
  plan: NativeTargetAuthOnlyPlan;
  configuration: HostedOperatorSourceConfiguration;
  environment: Readonly<Record<string, string | undefined>>;
}): AuthOnlyCredentialContext => {
  const plan = nativeTargetAuthOnlyPlanSchema.parse(input.plan);
  const profile = resolveNativeTargetResourceProfile({
    base: input.configuration,
    resourceProfileId: plan.authResource.profileId,
    authority: plan.origin.authority,
    appId: plan.appId,
    environment: input.environment,
  });
  const roles = profile.authOnlyApplications?.[plan.appId]?.accessRoles;
  const binding = {
    authDatabase: profile.authDatabase,
    nativeNeon: profile.nativeNeon,
    gateway: {
      projectId: profile.gateway.projectId,
      environment: profile.gateway.environment,
      branch: profile.gateway.branch,
      authBrowserOrigin: profile.gateway.authBrowserOrigin,
      gatewayOrigin: profile.gateway.gatewayOrigin,
      publicOrigin: profile.gateway.publicOrigin,
      workload: profile.gateway.workload,
    },
    operator: {
      projectId: profile.operator.projectId,
      environment: profile.operator.environment,
      origin: profile.operator.origin,
    },
  };
  const authorityDigest = nativeTargetAuthOnlyAuthorityDigest({
    authority: plan.origin.authority,
    appId: plan.appId,
    profileId: plan.authResource.profileId,
    authDatabase: profile.authDatabase,
    roles: roles ?? [],
    authorityBinding: binding,
    physicalEndpointId: profile.nativeNeon.scope.endpointId,
  });
  if (
    roles === undefined ||
    !roles.includes(plan.appRole) ||
    profile.applications[plan.appId] !== undefined ||
    authorityDigest !== plan.authResource.authorityDigest
  ) throw new Error("native_target_auth_only_credential_resource_mismatch");
  return authOnlyCredentialContextSchema.parse({
    authority: plan.origin.authority,
    appId: plan.appId,
    sessionId: plan.origin.publicSessionId,
    operationRef: nativeTargetAuthOnlyCredentialOperationRef(plan),
    profile: { id: plan.authResource.profileId, authorityDigest },
    resource: {
      resourceId: profile.authDatabase.resourceId,
      environment: "preview",
      database: profile.authDatabase.database,
      migratorRole: profile.authDatabase.migratorRole,
      runtimeRole: profile.authDatabase.runtimeRole,
      neon: {
        projectId: profile.nativeNeon.scope.projectId,
        branchId: profile.nativeNeon.scope.branchId,
        endpointId: profile.nativeNeon.scope.endpointId,
        hostname: profile.nativeNeon.scope.hostname,
      },
    },
  });
};

/** Revalidates the retained plan, settled approval, owner and selected profile at every secret access. */
export const createNativeTargetAuthOnlyCredentialAuthority = (input: {
  context: AuthOnlyCredentialContext;
  plan: NativeTargetAuthOnlyPlan;
  configuration: HostedOperatorSourceConfiguration;
  environment: Readonly<Record<string, string | undefined>>;
  artifactContext: OperatorArtifactContext;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
  readRetainedPlan: () => Promise<NativeTargetAuthOnlyPlan | undefined>;
  readApproval: () => Promise<NativeTargetAuthOnlyApproval | null>;
}) => async (rawContext: AuthOnlyCredentialContext) => {
  const context = authOnlyCredentialContextSchema.parse(rawContext);
  if (!isDeepStrictEqual(context, input.context)) throw new Error("native_target_auth_only_credential_context_mismatch");
  const plan = nativeTargetAuthOnlyPlanSchema.parse(input.plan);
  const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
  const expectedContext = nativeTargetAuthOnlyCredentialContextForPlan({
    plan,
    configuration: input.configuration,
    environment: input.environment,
  });
  if (
    !isDeepStrictEqual(context, expectedContext) ||
    input.artifactContext.target.appId !== plan.appId ||
    input.artifactContext.target.sessionId !== plan.origin.publicSessionId ||
    !isDeepStrictEqual(input.artifactContext.authority, plan.origin.authority)
  ) throw new Error("native_target_auth_only_credential_context_mismatch");
  await input.assertCurrentOwner(input.artifactContext);
  const retained = await input.readRetainedPlan();
  if (retained === undefined || !isDeepStrictEqual(retained, plan)) throw new Error("native_target_auth_only_credential_plan_changed");
  const approval = nativeTargetAuthOnlyApprovalSchema.parse(await input.readApproval());
  if (
    approval.outcome !== "approved" ||
    approval.planDigest !== planDigest ||
    approval.sourceDigest !== nativeTargetAuthOnlySchemaEffectDigest(plan, plan.publishedSource) ||
    approval.publicSessionId !== plan.origin.publicSessionId ||
    approval.responderPrincipalId !== plan.origin.authority.ownerUserId
  ) throw new Error("native_target_auth_only_credential_approval_required");
  await input.assertCurrentOwner(input.artifactContext);
  return {
    authorityDigest: expectedContext.profile.authorityDigest,
    resource: expectedContext.resource,
  };
};

/** Complete private custody binding for one retained and approved Auth-only plan. */
export const createNativeTargetAuthOnlyCredentialCustody = (input: {
  database: Database;
  keyring: VercelTokenKeyringConfig;
  context: AuthOnlyCredentialContext;
  plan: NativeTargetAuthOnlyPlan;
  configuration: HostedOperatorSourceConfiguration;
  environment: Readonly<Record<string, string | undefined>>;
  artifactContext: OperatorArtifactContext;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
  readRetainedPlan: () => Promise<NativeTargetAuthOnlyPlan | undefined>;
  readApproval: () => Promise<NativeTargetAuthOnlyApproval | null>;
}) => {
  const context = authOnlyCredentialContextSchema.parse(input.context);
  const assertCurrent = createNativeTargetAuthOnlyCredentialAuthority({ ...input, context });
  const credentials = createHostedOperatorAuthOnlyCredentials({
    keyring: input.keyring,
    store: createPostgresNativeTargetAuthOnlyCredentialStore(input.database),
  });
  return {
    findReference: async () => await credentials.findReference({ context, assertCurrent }),
    readSecrets: async (reference: Parameters<typeof credentials.readSecrets>[0]["reference"]) =>
      await credentials.readSecrets({ context, reference, assertCurrent }),
    seal: async (secret: { migratorPassword: string; runtimePassword: string }) =>
      await credentials.seal({ context, credentials: secret, assertCurrent }),
    read: async (
      reference: Parameters<typeof credentials.read>[0]["reference"],
      runtimeConnection: "direct" | "pooled" = "direct",
    ) => await credentials.read({ context, reference, runtimeConnection, assertCurrent }),
  };
};
