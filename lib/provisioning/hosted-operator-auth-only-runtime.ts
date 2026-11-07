import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals, prototypeArtifactChunks } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle type requires complete schema.
import type * as databaseSchema from "../db/schema";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import {
  capturedStaticDescriptionProvenance,
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import { publishedAppSourceSchema } from "./hosted-operator-artifact-selection";
import type { PublishedAppSource } from "./hosted-operator-artifact-selection";
import { resolveNativeTargetResourceProfile } from "./native-target-resource-profile";
import {
  nativeTargetAuthOnlyAuthorityDigest,
  planNativeTargetAuthOnly,
} from "./native-target-auth-only-planner";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export const readNativeTargetAuthOnlyPublishedSource = async (input: {
  database: Database;
  context: OperatorArtifactContext;
  appSpecDigest: string;
  description: unknown;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}): Promise<PublishedAppSource | undefined> => {
  const authority = hostedTenantAuthoritySchema.parse(input.context.authority);
  const where = and(
    eq(prototypeArtifactChunks.issuer, authority.issuer),
    eq(prototypeArtifactChunks.audience, authority.audience),
    eq(prototypeArtifactChunks.workspaceId, authority.workspaceId),
    eq(prototypeArtifactChunks.ownerUserId, authority.ownerUserId),
    eq(prototypeArtifactChunks.sessionId, input.context.target.sessionId),
    eq(
      prototypeArtifactChunks.path,
      `_protected-operator/static-published-source/${input.context.target.appId}/${input.appSpecDigest}`,
    ),
    eq(prototypeArtifactChunks.chunkIndex, 0),
  );
  await input.assertCurrentOwner(input.context);
  const rows = await input.database
    .select()
    .from(prototypeArtifactChunks)
    .where(where)
    .orderBy(desc(prototypeArtifactChunks.createdAt), desc(prototypeArtifactChunks.transferDigest))
    .limit(1);
  await input.assertCurrentOwner(input.context);
  const row = rows.at(0);
  if (row === undefined || digest(row.content) !== row.chunkDigest) {
    return undefined;
  }
  const parsed = z
    .strictObject({
      appId: z.string(),
      appSpecDigest: z.string(),
      descriptionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      source: publishedAppSourceSchema,
      version: z.literal(1),
    })
    .safeParse(JSON.parse(row.content));
  if (
    !parsed.success ||
    parsed.data.appId !== input.context.target.appId ||
    parsed.data.appSpecDigest !== input.appSpecDigest ||
    parsed.data.descriptionSha256 !== capturedStaticDescriptionProvenance(input.description).sha256
  ) {
    return undefined;
  }
  return parsed.data.source;
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeTargetAuthOnlySchemaApprovalSchema = z.strictObject({
  callId: z.string().min(1),
  observedAt: z.iso.datetime({ offset: true }),
  outcome: z.enum(["approved", "cancelled"]),
  planDigest: sha256Schema,
  publicSessionId: z.string().min(1),
  requestId: z.string().min(1),
  responderPrincipalId: z.string().min(1),
  sourceDigest: sha256Schema,
});
export type NativeTargetAuthOnlySchemaApproval = z.infer<
  typeof nativeTargetAuthOnlySchemaApprovalSchema
>;

const approvalFields = {
  approval: nativeTargetAuthOnlySchemaApprovalSchema,
  effectDigest: sha256Schema,
};
const stateSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    kind: z.literal("native-target-auth-only-runtime"),
    plan: nativeTargetAuthOnlyPlanSchema,
    planDigest: sha256Schema,
    source: publishedAppSourceSchema,
    stage: z.literal("planned"),
    version: z.literal(1),
  }),
  z.strictObject({
    kind: z.literal("native-target-auth-only-runtime"),
    plan: nativeTargetAuthOnlyPlanSchema,
    planDigest: sha256Schema,
    source: publishedAppSourceSchema,
    stage: z.literal("approved"),
    version: z.literal(1),
    ...approvalFields,
  }),
  z.strictObject({
    kind: z.literal("native-target-auth-only-runtime"),
    version: z.literal(1),
    stage: z.literal("dispatching"),
    plan: nativeTargetAuthOnlyPlanSchema,
    planDigest: sha256Schema,
    source: publishedAppSourceSchema,
    ...approvalFields,
    attemptId: z.uuid(),
    leaseId: z.uuid(),
    leaseExpiresAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    kind: z.literal("native-target-auth-only-runtime"),
    version: z.literal(1),
    stage: z.literal("unknown"),
    plan: nativeTargetAuthOnlyPlanSchema,
    planDigest: sha256Schema,
    source: publishedAppSourceSchema,
    ...approvalFields,
    attemptId: z.uuid(),
    leaseId: z.uuid(),
    leaseExpiresAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    kind: z.literal("native-target-auth-only-runtime"),
    version: z.literal(1),
    stage: z.literal("prepared"),
    plan: nativeTargetAuthOnlyPlanSchema,
    planDigest: sha256Schema,
    source: publishedAppSourceSchema,
    ...approvalFields,
    attemptId: z.uuid(),
    leaseId: z.uuid(),
    leaseExpiresAt: z.iso.datetime({ offset: true }),
    authSchema: z.strictObject({
      artifactRef: z.string().min(1),
      planDigest: sha256Schema,
      targetDigest: sha256Schema,
    }),
    readiness: z.string().min(1),
  }),
]);
type State = z.infer<typeof stateSchema>;
type Database = PostgresJsDatabase<typeof databaseSchema>;
export interface NativeTargetAuthOnlyRuntimeStore {
  read: (key: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    appId: string;
    sessionId: string;
  }) => Promise<{ revision: number; state: State } | undefined>;
  write: (
    key: {
      authority: z.infer<typeof hostedTenantAuthoritySchema>;
      appId: string;
      sessionId: string;
    },
    expectedRevision: number | undefined,
    state: State,
  ) => Promise<{ revision: number; state: State }>;
  compareAndSet: (
    key: {
      authority: z.infer<typeof hostedTenantAuthoritySchema>;
      appId: string;
      sessionId: string;
    },
    expectedRevision: number,
    state: State,
  ) => Promise<{ revision: number; state: State } | undefined>;
}
const requestIdFor = (key: {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
  sessionId: string;
}) => {
  const hex = digest(
    JSON.stringify([
      "native-target-auth-only-runtime-v1",
      key.authority.issuer,
      key.authority.audience,
      key.authority.workspaceId,
      key.authority.ownerUserId,
      key.appId,
      key.sessionId,
    ]),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const journalState = (state: State) => (state.stage === "prepared" ? "settled" : "pending");
export const createPostgresNativeTargetAuthOnlyRuntimeStore = (
  database: Database,
): NativeTargetAuthOnlyRuntimeStore => {
  const predicate = (key: Parameters<NativeTargetAuthOnlyRuntimeStore["read"]>[0]) =>
    and(
      eq(builderProvisioningJournals.issuer, key.authority.issuer),
      eq(builderProvisioningJournals.audience, key.authority.audience),
      eq(builderProvisioningJournals.workspaceId, key.authority.workspaceId),
      eq(builderProvisioningJournals.ownerUserId, key.authority.ownerUserId),
      eq(builderProvisioningJournals.requestId, requestIdFor(key)),
      sql`${builderProvisioningJournals.record} ->> 'kind' = 'native-target-auth-only-runtime'`,
    );
  const parse = (row: typeof builderProvisioningJournals.$inferSelect) => {
    const authority = hostedTenantAuthoritySchema.parse({
      audience: row.audience,
      issuer: row.issuer,
      ownerUserId: row.ownerUserId,
      workspaceId: row.workspaceId,
    });
    const state = stateSchema.parse(row.record);
    if (
      row.requestId !==
        requestIdFor({
          appId: state.plan.appId,
          authority,
          sessionId: state.plan.origin.publicSessionId,
        }) ||
      row.requestDigest !== state.planDigest ||
      row.state !== journalState(state)
    ) {
      throw new Error("native_target_auth_only_runtime_mismatch");
    }
    return { revision: row.revision, state };
  };
  return {
    async compareAndSet(key, expectedRevision, rawState) {
      const state = stateSchema.parse(rawState);
      if (
        state.plan.appId !== key.appId ||
        state.plan.origin.publicSessionId !== key.sessionId ||
        !isDeepStrictEqual(state.plan.origin.authority, key.authority)
      ) {
        throw new Error("native_target_auth_only_runtime_mismatch");
      }
      const rows = await database
        .update(builderProvisioningJournals)
        .set({
          record: state,
          revision: expectedRevision + 1,
          state: journalState(state),
          updatedAt: new Date(),
        })
        .where(and(predicate(key), eq(builderProvisioningJournals.revision, expectedRevision)))
        .returning();
      return rows[0] === undefined ? undefined : parse(rows[0]);
    },
    async read(key) {
      const rows = await database
        .select()
        .from(builderProvisioningJournals)
        .where(predicate(key))
        .limit(1);
      return rows[0] === undefined ? undefined : parse(rows[0]);
    },
    async write(key, expectedRevision, rawState) {
      const state = stateSchema.parse(rawState);
      if (
        state.plan.appId !== key.appId ||
        state.plan.origin.publicSessionId !== key.sessionId ||
        !isDeepStrictEqual(state.plan.origin.authority, key.authority)
      ) {
        throw new Error("native_target_auth_only_runtime_mismatch");
      }
      const now = new Date();
      if (expectedRevision === undefined) {
        const rows = await database
          .insert(builderProvisioningJournals)
          .values({
            ...key.authority,
            requestId: requestIdFor(key),
            requestDigest: state.planDigest,
            record: state,
            revision: 1,
            state: journalState(state),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (rows[0] !== undefined) {
          return parse(rows[0]);
        }
        const current = await this.read(key);
        if (current !== undefined && isDeepStrictEqual(current.state, state)) {
          return current;
        }
        throw new Error("native_target_auth_only_runtime_conflict");
      }
      const saved = await this.compareAndSet(key, expectedRevision, state);
      if (saved === undefined) {
        throw new Error("native_target_auth_only_runtime_conflict");
      }
      return saved;
    },
  };
};

const runtimeKey = (plan: NativeTargetAuthOnlyPlan) => ({
  appId: plan.appId,
  authority: plan.origin.authority,
  sessionId: plan.origin.publicSessionId,
});
const sourceMatches = (left: PublishedAppSource, right: PublishedAppSource) =>
  isDeepStrictEqual(left, right);
const selectedProfile = (
  configuration: HostedOperatorSourceConfiguration,
  plan: NativeTargetAuthOnlyPlan,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const selected = resolveNativeTargetResourceProfile({
    appId: plan.appId,
    authority: plan.origin.authority,
    base: configuration,
    environment,
    resourceProfileId: plan.authResource.profileId,
  });
  const roles = selected.authOnlyApplications?.[plan.appId]?.accessRoles ?? [];
  const binding = {
    authDatabase: selected.authDatabase,
    gateway: {
      authBrowserOrigin: selected.gateway.authBrowserOrigin,
      branch: selected.gateway.branch,
      environment: selected.gateway.environment,
      gatewayOrigin: selected.gateway.gatewayOrigin,
      projectId: selected.gateway.projectId,
      publicOrigin: selected.gateway.publicOrigin,
      workload: selected.gateway.workload,
    },
    nativeNeon: selected.nativeNeon,
    operator: {
      environment: selected.operator.environment,
      origin: selected.operator.origin,
      projectId: selected.operator.projectId,
    },
  };
  if (
    nativeTargetAuthOnlyAuthorityDigest({
      appId: plan.appId,
      authDatabase: selected.authDatabase,
      authority: plan.origin.authority,
      authorityBinding: binding,
      physicalEndpointId: selected.nativeNeon.scope.endpointId,
      profileId: plan.authResource.profileId,
      roles,
    }) !== plan.authResource.authorityDigest
  ) {
    throw new Error("native_target_auth_only_resource_mismatch");
  }
  return selected;
};

/** Static source association and Auth schema preparation; no app DB, grant or deployment port exists here. */
export const createNativeTargetAuthOnlyRuntime = (input: {
  database: Database;
  store?: NativeTargetAuthOnlyRuntimeStore;
  configuration: HostedOperatorSourceConfiguration;
  environment: Readonly<Record<string, string | undefined>>;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
  readPublishedSource: (
    context: OperatorArtifactContext,
  ) => Promise<PublishedAppSource | undefined>;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Captured storage JSON stays untrusted until the planner and provenance schemas validate it.
  readCapturedDescription: (context: OperatorArtifactContext) => Promise<unknown>;
  readAuthSchemaSelection: (input: {
    context: OperatorArtifactContext;
    source: PublishedAppSource;
  }) => Promise<NativeTargetAuthOnlyPlan["authSchema"]>;
  prepareAuthSchema: (input: {
    plan: NativeTargetAuthOnlyPlan;
    source: PublishedAppSource;
    approval: NativeTargetAuthOnlySchemaApproval;
    attemptId: string;
    leaseId: string;
    assertCurrent: () => Promise<void>;
  }) => Promise<{
    authSchema: Extract<State, { stage: "prepared" }>["authSchema"];
    readiness: string;
  }>;
  reconcileAuthSchema: (input: {
    plan: NativeTargetAuthOnlyPlan;
    source: PublishedAppSource;
    approval: NativeTargetAuthOnlySchemaApproval;
    attemptId: string;
    leaseId: string;
    assertCurrent: () => Promise<void>;
  }) => Promise<
    | {
        status: "prepared";
        authSchema: Extract<State, { stage: "prepared" }>["authSchema"];
        readiness: string;
      }
    | { status: "not-applied" }
    | { status: "uncertain" }
  >;
  readApproval: (input: {
    context: OperatorArtifactContext;
    plan: NativeTargetAuthOnlyPlan;
    source: PublishedAppSource;
    planDigest: string;
    effectDigest: string;
  }) => Promise<NativeTargetAuthOnlySchemaApproval | null>;
  now?: () => Date;
  leaseMs?: number;
}) => {
  const readApprovedPreparation = async (
    context: OperatorArtifactContext,
    plan: NativeTargetAuthOnlyPlan,
    expectedPlanDigest: string,
  ) => {
    const authority = hostedTenantAuthoritySchema.parse(context.authority);
    if (
      context.target.appId !== plan.appId ||
      context.target.sessionId !== plan.origin.publicSessionId
    ) {
      throw new Error("native_target_auth_only_runtime_mismatch");
    }
    const store = input.store ?? createPostgresNativeTargetAuthOnlyRuntimeStore(input.database);
    const key = runtimeKey(plan);
    await input.assertCurrentOwner(context);
    const current = await store.read(key);
    if (current === undefined || current.state.planDigest !== expectedPlanDigest) {
      throw new Error("native_target_auth_only_conflict");
    }
    if (
      nativeTargetAuthOnlyPlanDigest(plan) !== expectedPlanDigest ||
      !isDeepStrictEqual(current.state.plan, plan) ||
      !isDeepStrictEqual(plan.origin.authority, authority)
    ) {
      throw new Error("native_target_auth_only_conflict");
    }
    const description = await input.readCapturedDescription(context);
    if (
      !isDeepStrictEqual(
        capturedStaticDescriptionProvenance(description),
        plan.origin.capturedDescription,
      )
    ) {
      throw new Error("native_target_auth_only_source_mismatch");
    }
    const published = publishedAppSourceSchema.parse(await input.readPublishedSource(context));
    if (
      !sourceMatches(published, current.state.source) ||
      !sourceMatches(published, plan.publishedSource) ||
      published.branch !== plan.branch
    ) {
      throw new Error("native_target_auth_only_source_mismatch");
    }
    selectedProfile(input.configuration, plan, input.environment);
    const effectDigest = nativeTargetAuthOnlySchemaEffectDigest(plan, published);
    const approvalValue = await input.readApproval({
      context,
      effectDigest,
      plan,
      planDigest: expectedPlanDigest,
      source: published,
    });
    if (approvalValue === null) {
      throw new Error("native_target_auth_only_approval_required");
    }
    const approval = nativeTargetAuthOnlySchemaApprovalSchema.parse(approvalValue);
    if (
      !isDeepStrictEqual(
        {
          outcome: approval.outcome,
          planDigest: approval.planDigest,
          sourceDigest: approval.sourceDigest,
          publicSessionId: approval.publicSessionId,
          responderPrincipalId: approval.responderPrincipalId,
        },
        {
          outcome: "approved",
          planDigest: expectedPlanDigest,
          sourceDigest: effectDigest,
          publicSessionId: plan.origin.publicSessionId,
          responderPrincipalId: authority.ownerUserId,
        },
      )
    ) {
      throw new Error("native_target_auth_only_approval_mismatch");
    }
    return { current, approval, effectDigest, store, key, published };
  };
  const resumePreviousAttempt = async (
    context: OperatorArtifactContext,
    plan: NativeTargetAuthOnlyPlan,
    expectedPlanDigest: string,
    preparation: Awaited<ReturnType<typeof readApprovedPreparation>>,
    now: () => Date,
  ) => {
    const { current, approval, effectDigest, store, key, published } = preparation;
    let row = current;
    if (row.state.stage === "planned") {
      row = await store.write(
        key,
        row.revision,
        stateSchema.parse({ ...row.state, approval, effectDigest, stage: "approved" }),
      );
    } else if (
      row.state.stage === "approved" &&
      (!isDeepStrictEqual(row.state.approval, approval) || row.state.effectDigest !== effectDigest)
    ) {
      throw new Error("native_target_auth_only_approval_mismatch");
    } else if (row.state.stage === "dispatching") {
      if (
        !isDeepStrictEqual(row.state.approval, approval) ||
        row.state.effectDigest !== effectDigest
      ) {
        throw new Error("native_target_auth_only_approval_mismatch");
      }
      if (Date.parse(row.state.leaseExpiresAt) > now().getTime()) {
        throw new Error("native_target_auth_only_busy");
      }
      row = await store.write(
        key,
        row.revision,
        stateSchema.parse({ ...row.state, stage: "unknown" }),
      );
    }
    if (row.state.stage === "unknown") {
      if (
        !isDeepStrictEqual(row.state.approval, approval) ||
        row.state.effectDigest !== effectDigest
      ) {
        throw new Error("native_target_auth_only_approval_mismatch");
      }
      const reconciled = await input.reconcileAuthSchema({
        approval,
        assertCurrent: async () => {
          await input.assertCurrentOwner(context);
        },
        attemptId: row.state.attemptId,
        leaseId: row.state.leaseId,
        plan,
        source: published,
      });
      await input.assertCurrentOwner(context);
      if (reconciled.status === "prepared") {
        const prepared = stateSchema.parse({
          ...row.state,
          authSchema: reconciled.authSchema,
          readiness: reconciled.readiness,
          stage: "prepared",
        });
        const persisted = await store.write(key, row.revision, prepared);
        return persisted;
      }
      if (reconciled.status === "uncertain") {
        throw new Error("native_target_auth_only_reconciliation_required");
      }
      row = await store.write(
        key,
        row.revision,
        stateSchema.parse({
          approval,
          effectDigest,
          kind: "native-target-auth-only-runtime",
          plan,
          planDigest: expectedPlanDigest,
          source: published,
          stage: "approved",
          version: 1,
        }),
      );
    }
    return row;
  };
  return {
    async plan(
      context: OperatorArtifactContext,
      proposal: {
        appId: string;
        project: Pick<NativeTargetAuthOnlyPlan["project"], "name" | "teamId" | "installationId">;
        branch: string;
        appRole: string;
        appSpecDigest: string;
        adapterSessionId: string;
        adapterGeneration: number;
        authProfileId: string;
      },
    ) {
      const authority = hostedTenantAuthoritySchema.parse(context.authority);
      if (context.target.appId !== proposal.appId || context.target.sessionId.length === 0) {
        throw new Error("native_target_auth_only_runtime_mismatch");
      }
      const description = await input.readCapturedDescription(context);
      const source = publishedAppSourceSchema.parse(await input.readPublishedSource(context));
      const authSchema = await input.readAuthSchemaSelection({ context, source });
      const profile = resolveNativeTargetResourceProfile({
        appId: proposal.appId,
        authority,
        base: input.configuration,
        environment: input.environment,
        resourceProfileId: proposal.authProfileId,
      });
      const roles = profile.authOnlyApplications?.[proposal.appId]?.accessRoles;
      if (
        roles === undefined ||
        !roles.includes(proposal.appRole) ||
        input.configuration.applications[proposal.appId] !== undefined
      ) {
        throw new Error("native_target_auth_only_resource_mismatch");
      }
      const authorityBinding = {
        authDatabase: profile.authDatabase,
        gateway: {
          authBrowserOrigin: profile.gateway.authBrowserOrigin,
          branch: profile.gateway.branch,
          environment: profile.gateway.environment,
          gatewayOrigin: profile.gateway.gatewayOrigin,
          projectId: profile.gateway.projectId,
          publicOrigin: profile.gateway.publicOrigin,
          workload: profile.gateway.workload,
        },
        nativeNeon: profile.nativeNeon,
        operator: {
          environment: profile.operator.environment,
          origin: profile.operator.origin,
          projectId: profile.operator.projectId,
        },
      };
      const plan = planNativeTargetAuthOnly({
        authAuthorityBinding: authorityBinding,
        authSchema,
        capturedDescription: description,
        configuredAppRoles: roles,
        owner: {
          adapterGeneration: proposal.adapterGeneration,
          adapterSessionId: proposal.adapterSessionId,
          authority,
          publicSessionId: context.target.sessionId,
        },
        proposal: {
          appId: proposal.appId,
          appRole: proposal.appRole,
          appSpecDigest: proposal.appSpecDigest,
          authProfileId: proposal.authProfileId,
          branch: proposal.branch,
          project: proposal.project,
        },
        publishedSource: source,
        selectedPhysicalEndpointId: profile.nativeNeon.scope.endpointId,
        selectedProfile: {
          appId: proposal.appId,
          authority,
          configuration: profile,
          id: proposal.authProfileId,
        },
        sharedAuthResourceId: input.configuration.authDatabase.resourceId,
        sharedPhysicalEndpointId: input.configuration.nativeNeon.scope.endpointId,
      });
      if (source.repositoryId.length === 0 || source.branch !== proposal.branch) {
        throw new Error("native_target_auth_only_source_mismatch");
      }
      const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
      const store = input.store ?? createPostgresNativeTargetAuthOnlyRuntimeStore(input.database);
      const key = runtimeKey(plan);
      const existing = await store.read(key);
      if (
        existing !== undefined &&
        (!isDeepStrictEqual(existing.state.plan, plan) ||
          !sourceMatches(existing.state.source, source))
      ) {
        throw new Error("native_target_auth_only_conflict");
      }
      if (existing === undefined) {
        await store.write(key, undefined, {
          kind: "native-target-auth-only-runtime",
          version: 1,
          stage: "planned",
          plan,
          planDigest,
          source,
        });
      }
      await input.assertCurrentOwner(context);
      return { plan, planDigest, status: "planned" as const };
    },
    async prepare(
      context: OperatorArtifactContext,
      plan: NativeTargetAuthOnlyPlan,
      expectedPlanDigest: string,
    ) {
      const preparation = await readApprovedPreparation(context, plan, expectedPlanDigest);
      const { current, approval, effectDigest, store, key, published } = preparation;
      if (current.state.stage === "prepared") {
        if (
          current.state.effectDigest !== effectDigest ||
          !isDeepStrictEqual(current.state.approval, approval)
        ) {
          throw new Error("native_target_auth_only_approval_mismatch");
        }
        return current.state;
      }
      const now = input.now ?? (() => new Date());
      let row = await resumePreviousAttempt(context, plan, expectedPlanDigest, preparation, now);
      if (row.state.stage === "prepared") {
        return row.state;
      }
      if (row.state.stage !== "approved" || !isDeepStrictEqual(row.state.approval, approval)) {
        throw new Error("native_target_auth_only_conflict");
      }
      const attemptId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const leaseExpiresAt = new Date(
        now().getTime() + (input.leaseMs ?? 20 * 60_000),
      ).toISOString();
      row = await store.write(
        key,
        row.revision,
        stateSchema.parse({
          ...row.state,
          attemptId,
          leaseExpiresAt,
          leaseId,
          stage: "dispatching",
        }),
      );
      const assertLease = async () => {
        await input.assertCurrentOwner(context);
        const latest = await store.read(key);
        if (
          latest?.state.stage !== "dispatching" ||
          latest.state.attemptId !== attemptId ||
          latest.state.leaseId !== leaseId ||
          Date.parse(latest.state.leaseExpiresAt) <= now().getTime()
        ) {
          throw new Error("native_target_auth_only_lease_lost");
        }
        row = latest;
      };
      try {
        const result = await input.prepareAuthSchema({
          approval,
          assertCurrent: assertLease,
          attemptId,
          leaseId,
          plan,
          source: published,
        });
        await assertLease();
        const prepared = stateSchema.parse({ ...row.state, ...result, stage: "prepared" });
        const persisted = await store.write(key, row.revision, prepared);
        return persisted.state;
      } catch (error) {
        const latest = await store.read(key);
        if (
          latest?.state.stage === "dispatching" &&
          latest.state.attemptId === attemptId &&
          latest.state.leaseId === leaseId
        ) {
          await store.write(
            key,
            latest.revision,
            stateSchema.parse({ ...latest.state, stage: "unknown" }),
          );
        }
        throw error;
      }
    },
  };
};
