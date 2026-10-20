import { createHash } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import { hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { reportOperatorExecutionFailure } from "./hosted-operator-consent-diagnostic";
import type { OperatorRuntimeReadinessStage } from "./hosted-operator-consent-diagnostic";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const reject = () => new Error("hosted_app_runtime_readiness_unconfirmed");
const manifestSchema = z.object({
  app: z.string(),
  hashes: z.object({ schema: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }),
  schema_version: z.string(),
});
const releaseSchema = z.object({
  artifact_hashes: z.object({ base: hash, effective: hash, schema: hash }),
  base_revision: z.string(),
  preparation: z.object({ state: z.string() }),
  release_id: z.string(),
  runtime_schema: z.object({ status: z.string() }),
  schema_revision_id: z.number().int().positive(),
});
const observationSchema = z.object({
  data: z.object({
    active_base_revision: z.string(),
    active_effective_artifact_hash: hash,
    active_schema_revision_id: z.number().int().positive(),
    app_id: z.string(),
    customer_id: z.string(),
    releases: z.array(releaseSchema),
  }),
  ok: z.literal(true),
});

const identitySchema = z.object({
  branch: z.string(),
  can_create: z.boolean(),
  can_temp: z.boolean(),
  comment: z.string(),
  database: z.string(),
  endpoint: z.string().min(1),
  login: z.string(),
  owner: z.string(),
  owns_public_objects: z.boolean(),
  privileged_membership: z.boolean(),
  project: z.string(),
  rolbypassrls: z.boolean(),
  rolcreatedb: z.boolean(),
  rolcreaterole: z.boolean(),
  role: z.string(),
  rolreplication: z.boolean(),
  rolsuper: z.boolean(),
});
const assertRuntimeUrl = (runtimeUrl: string, plan: HostedOperatorPlan) => {
  const url = new URL(runtimeUrl);
  const conditions = [
    ["postgres:", "postgresql:"].includes(url.protocol),
    url.hostname === plan.neon.endpoint,
    !url.hostname.includes("-pooler."),
    Number(url.port || 5432) === 5432,
    decodeURIComponent(url.pathname.slice(1)) === plan.appDatabase.database,
    decodeURIComponent(url.username) === plan.appDatabase.runtimeRole,
    url.password.length > 0,
    url.hash.length === 0,
    url.searchParams.getAll("sslmode").length === 1,
    url.searchParams.get("sslmode") === "verify-full",
    [...url.searchParams.keys()].every((key) => ["sslmode", "channel_binding"].includes(key)),
    url.searchParams.getAll("channel_binding").length <= 1,
    !url.searchParams.has("channel_binding") ||
      url.searchParams.get("channel_binding") === "require",
  ];
  if (!conditions.every(Boolean)) {
    throw reject();
  }
};
const assertIdentity = (row: z.infer<typeof identitySchema>, plan: HostedOperatorPlan) => {
  const conditions = [
    row.database === plan.appDatabase.database,
    row.role === plan.appDatabase.runtimeRole,
    row.login === plan.appDatabase.runtimeRole,
    row.owner === plan.appDatabase.migratorRole,
    row.comment === `protected-resource:v1:app_database:${plan.appDatabase.resourceId}:database`,
    row.project === plan.neon.projectId,
    row.branch === plan.neon.branchId,
    plan.bootstrap === undefined || row.endpoint === plan.bootstrap.endpointId,
    [
      row.rolsuper,
      row.rolcreatedb,
      row.rolcreaterole,
      row.rolreplication,
      row.rolbypassrls,
      row.privileged_membership,
      row.owns_public_objects,
      row.can_create,
      row.can_temp,
    ].every((flag) => !flag),
  ];
  if (!conditions.every(Boolean)) {
    throw reject();
  }
};

const IDENTITY_SQL = `select current_database() as database,
          current_user as role, session_user as login,
          current_setting('neon.project_id',true) as project,
          current_setting('neon.branch_id',true) as branch,
          current_setting('neon.endpoint_id',true) as endpoint,
          pg_catalog.pg_get_userbyid(d.datdba) as owner,
          pg_catalog.shobj_description(d.oid,'pg_database') as comment,
          r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
          exists(select 1 from pg_roles elevated where elevated.oid<>r.oid
            and pg_has_role(r.oid,elevated.oid,'MEMBER') and
            (elevated.rolsuper or elevated.rolcreatedb or elevated.rolcreaterole
             or elevated.rolreplication or elevated.rolbypassrls
             or elevated.rolname in ('neon_superuser','neondb_owner','pg_read_all_data','pg_write_all_data','pg_execute_server_program','pg_read_server_files','pg_write_server_files'))) as privileged_membership,
          exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and pg_has_role(session_user,c.relowner,'MEMBER')) as owns_public_objects,
          has_database_privilege(session_user,current_database(),'CREATE') as can_create,
          has_database_privilege(session_user,current_database(),'TEMP') as can_temp
          from pg_database d join pg_roles r on r.rolname=session_user
          where d.datname=current_database()`;
export interface ObservedAppTenant {
  organizationId: string;
  schemaRevisionId: number;
  baseArtifactHash: string;
  effectiveArtifactHash: string;
}
export interface OperatorAppMetadataScope {
  appId: string;
  actorId: string;
  organizationId: string;
  role: string;
}
const actorBindingSchema = z.strictObject({
  active: z.literal(true),
  actorId: z.string(),
  appId: z.string(),
  fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  organizationId: z.string(),
  role: z.string(),
});

export interface AppRuntimeSnapshotReader {
  /** A closed inactive/missing binding is distinct from unreadable provider metadata. */
  readActiveOrganization?: (
    scope: OperatorAppMetadataScope,
  ) => Promise<z.infer<typeof observationSchema> | null>;
  readIdentity: () => Promise<z.infer<typeof identitySchema>>;
  readOrganization: (
    scope: OperatorAppMetadataScope,
    observeStage?: (stage: OperatorRuntimeReadinessStage) => void,
  ) => Promise<z.infer<typeof observationSchema>>;
}
export type ReadAppRuntimeSnapshot = (
  runtimeUrl: string,
  read: (reader: AppRuntimeSnapshotReader) => Promise<ObservedAppTenant[]>,
) => Promise<ObservedAppTenant[]>;
export const readAppRuntimeSnapshot: ReadAppRuntimeSnapshot = async (runtimeUrl, read) => {
  const sql = postgres(runtimeUrl, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
  try {
    return await sql.begin(
      // FOR SHARE admission is a locking read and PostgreSQL prohibits it in READ ONLY mode.
      "isolation level repeatable read",
      async (tx) => {
        const reader: AppRuntimeSnapshotReader = {
          readIdentity: async () => {
            const rows = await tx.unsafe(IDENTITY_SQL);
            if (rows.length !== 1) {
              throw reject();
            }
            return identitySchema.parse(rows[0]);
          },
          readActiveOrganization: async (scope) => {
            const rows = await tx.unsafe(
              "select public.kernel_read_actor_binding($1::jsonb) as binding",
              [
                tx.json({
                  actor_id: scope.actorId,
                  app_id: scope.appId,
                  customer_id: scope.organizationId,
                  role: scope.role,
                }),
              ],
            );
            if (rows.length !== 1) {
              throw reject();
            }
            const result: unknown = rows[0]?.binding;
            const inactiveScope = z
              .object({
                ok: z.literal(false),
                error: z.object({
                  code: z.literal("authorization_denied"),
                  details: z.array(z.object({ code: z.literal("scope_mismatch") })).min(1),
                }),
              })
              .safeParse(result);
            if (inactiveScope.success) {
              return null;
            }
            const envelope = z
              .object({
                ok: z.literal(true),
                data: actorBindingSchema
                  .extend({
                    active: z.boolean(),
                    fenceGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
                  })
                  .nullable(),
              })
              .parse(result);
            const binding = envelope.data;
            if (binding === null) {
              return null;
            }
            if (
              binding.appId !== scope.appId ||
              binding.actorId !== scope.actorId ||
              binding.organizationId !== scope.organizationId ||
              binding.role !== scope.role
            ) {
              throw reject();
            }
            if (!binding.active || binding.fenceGeneration === 0) {
              return null;
            }
            // Reuse the existing fence-checked observability read, including its locking admission.
            return await reader.readOrganization(scope);
          },
          readOrganization: async (scope, observeStage) => {
            observeStage?.("actor_binding");
            const bindings = await tx.unsafe(
              "select public.kernel_read_actor_binding($1::jsonb) as binding",
              [
                tx.json({
                  actor_id: scope.actorId,
                  app_id: scope.appId,
                  customer_id: scope.organizationId,
                  role: scope.role,
                }),
              ],
            );
            if (bindings.length !== 1) {
              throw reject();
            }
            const envelope = z
              .object({ data: actorBindingSchema, ok: z.literal(true) })
              .parse(bindings[0]?.binding);
            const binding = envelope.data;
            if (
              binding.appId !== scope.appId ||
              binding.actorId !== scope.actorId ||
              binding.organizationId !== scope.organizationId ||
              binding.role !== scope.role
            ) {
              throw reject();
            }
            observeStage?.("runtime_context");
            await tx.unsafe(
              "select set_config('kernel.actor_id',$1,true),set_config('kernel.actor_role',$2,true),set_config('kernel.actor_fence_generation',$3,true),set_config('kernel.app_id',$4,true),set_config('kernel.customer_id',$5,true)",
              [
                scope.actorId,
                scope.role,
                String(binding.fenceGeneration),
                scope.appId,
                scope.organizationId,
              ],
            );
            observeStage?.("runtime_release");
            const rows = await tx.unsafe(
              "select public.kernel_read_runtime_release_observability($1::jsonb) as observation",
              [tx.json({ app_id: scope.appId, customer_id: scope.organizationId })],
            );
            if (rows.length !== 1) {
              throw reject();
            }
            // The guarded kernel call above rechecks this exact active native fence
            // and locks its binding; this preliminary read cannot authorize stale metadata.
            return observationSchema.parse(rows[0]?.observation);
          },
        };
        return await read(reader);
      },
    );
  } finally {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // The snapshot result is already known; shutdown errors contain private provider details.
    }
  }
};
export type AppReadinessInput = HostedOperatorContext & {
  plan: HostedOperatorPlan;
  /** Supplied by the operator holding the actual resource lease. */
  assertCurrent: () => Promise<void>;
};
/** Retain only currently active, actor-bound prior app scopes; this does not require the desired release. */
export const readActiveAppInstallationCustomerIds = async (input: {
  plan: HostedOperatorPlan;
  runtimeUrl: string;
  scopes: readonly OperatorAppMetadataScope[];
  assertCurrent: () => Promise<void>;
  readRuntimeSnapshot?: ReadAppRuntimeSnapshot;
}): Promise<string[]> => {
  assertRuntimeUrl(input.runtimeUrl, input.plan);
  await input.assertCurrent();
  const observed = await (input.readRuntimeSnapshot ?? readAppRuntimeSnapshot)(
    input.runtimeUrl,
    async (reader) => {
      assertIdentity(await reader.readIdentity(), input.plan);
      if (reader.readActiveOrganization === undefined) {
        throw reject();
      }
      const observations: ObservedAppTenant[] = [];
      for (const scope of input.scopes) {
        // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Serialize approved tenant contexts on the same metadata transaction.
        await input.assertCurrent();
        if (scope.appId !== input.plan.selection.appId) {
          throw reject();
        }
        // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each current actor binding is read under its exact approved tenant scope.
        const result = await reader.readActiveOrganization(scope);
        if (result === null) {
          continue;
        }
        const value = result.data;
        const active = value.releases.filter(
          (release) => release.schema_revision_id === value.active_schema_revision_id,
        );
        if (
          value.app_id !== scope.appId ||
          value.customer_id !== scope.organizationId ||
          active.length !== 1
        ) {
          throw reject();
        }
        observations.push({
          organizationId: scope.organizationId,
          schemaRevisionId: value.active_schema_revision_id,
          baseArtifactHash: active[0].artifact_hashes.base,
          effectiveArtifactHash: value.active_effective_artifact_hash,
        });
      }
      return observations;
    },
  );
  await input.assertCurrent();
  return [...new Set(observed.map((tenant) => tenant.organizationId))];
};

export interface AppReadinessDependencies {
  /** Trusted connection adapter; production uses fixed metadata queries and binding row locks. */
  readRuntimeSnapshot?: ReadAppRuntimeSnapshot;
  assertAuthorized: (input: HostedOperatorContext & { plan: HostedOperatorPlan }) => Promise<void>;
  /** Owner-bound private credential reader; never a caller/model URL. */
  readRuntimeUrl: (input: AppReadinessInput) => Promise<string>;
  /** Source-owned artifact reader. Its bytes must match the frozen manifest digest. */
  readReleaseManifest: (input: AppReadinessInput) => Promise<Uint8Array>;
}

/** Independent restricted-runtime readback; does not establish app business behavior. */
export const createHostedOperatorAppReadiness =
  (deps: AppReadinessDependencies) => async (input: AppReadinessInput) => {
    let runtimeReadinessStage: OperatorRuntimeReadinessStage = "selection";
    const observeStage = (stage: OperatorRuntimeReadinessStage) => {
      runtimeReadinessStage = stage;
    };
    try {
      const plan = hostedOperatorPlanSchema.parse(input.plan);
      const { target } = input;
      if (
        ![
          plan.action === "prepare",
          target.appId === plan.selection.appId,
          target.branch === plan.selection.branch,
          target.projectId === plan.selection.projectId,
          target.sessionId === plan.selection.sessionId,
          target.environment === plan.selection.environment,
        ].every(Boolean)
      ) {
        throw reject();
      }
      const guard = async () => {
        const priorStage = runtimeReadinessStage;
        observeStage("authority");
        await input.assertCurrent();
        await deps.assertAuthorized({ ...input, plan });
        observeStage(priorStage);
      };
      await guard();
      observeStage("approved_access");
      const approvedByOrganization = new Map<string, HostedOperatorPlan["access"][number]>();
      for (const access of plan.access) {
        if (!approvedByOrganization.has(access.organizationId)) {
          approvedByOrganization.set(access.organizationId, access);
        }
      }
      const organizations = [
        ...new Set(plan.access.map((access) => access.organizationId)),
      ].toSorted();
      if (organizations.length === 0) {
        throw reject();
      }
      observeStage("release_manifest");
      const bytes = await deps.readReleaseManifest(input);
      if (digest(bytes) !== plan.release.sha256) {
        throw reject();
      }
      const manifest = manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf-8")));
      if (manifest.app !== plan.selection.appId || manifest.schema_version !== plan.release.id) {
        throw reject();
      }
      const artifactHash = manifest.hashes.schema.slice("sha256:".length);
      observeStage("runtime_credential");
      const runtimeUrl = await deps.readRuntimeUrl(input);
      assertRuntimeUrl(runtimeUrl, plan);
      await guard();
      observeStage("runtime_connection");
      const observations = await (deps.readRuntimeSnapshot ?? readAppRuntimeSnapshot)(
        runtimeUrl,
        async (reader) => {
          observeStage("runtime_identity");
          assertIdentity(await reader.readIdentity(), plan);
          const results = [];
          // eslint-disable-next-line react-doctor/async-await-in-loop -- Tenant-scoped configuration and authorization must be serialized on this single snapshot connection.
          for (const organizationId of organizations) {
            // eslint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- Serialize tenant-scoped reads on one locking metadata transaction and recheck authority between them.
            await guard();
            observeStage("approved_access");
            // eslint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- One runtime transaction provides a consistent release observation for the approved tenant batch.
            const approved = approvedByOrganization.get(organizationId);
            const [role] = approved?.roles.toSorted() ?? [];
            if (approved === undefined || role === undefined) {
              throw reject();
            }
            observeStage("runtime_release");
            // eslint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- Keep approved tenant contexts sequential on one locking metadata transaction.
            const result = await reader.readOrganization(
              {
                actorId: approved.actorId,
                appId: plan.selection.appId,
                organizationId,
                role,
              },
              observeStage,
            );
            const { data: observation } = result;
            const active = observation.releases.filter(
              (release) => release.schema_revision_id === observation.active_schema_revision_id,
            );
            const [selected] = active;
            const releaseId = plan.release.id;
            if (
              ![
                observation.app_id === plan.selection.appId,
                observation.customer_id === organizationId,
                observation.active_base_revision === releaseId,
                active.length === 1,
                selected?.release_id === releaseId,
                selected?.base_revision === releaseId,
                selected?.artifact_hashes.base === artifactHash,
                selected?.artifact_hashes.effective === observation.active_effective_artifact_hash,
                selected?.preparation.state === "active",
                selected?.runtime_schema.status === "stored_schema_hash_matches",
              ].every(Boolean)
            ) {
              throw reject();
            }
            results.push({
              baseArtifactHash: artifactHash,
              effectiveArtifactHash: observation.active_effective_artifact_hash,
              organizationId,
              schemaRevisionId: observation.active_schema_revision_id,
            });
          }
          await guard();
          observeStage("runtime_connection");
          return results;
        },
      );
      await guard();
      return {
        // SQL release observation does not authenticate any human actor.
        actors: 0,
        artifactHash,
        authenticatedBehavior: "unassessed" as const,
        manifestSha256: digest(bytes),
        observations,
        observedAt: new Date().toISOString(),
        releaseId: plan.release.id,
        resourceId: plan.appDatabase.resourceId,
        source: "reviewed-plan-app-runtime" as const,
        tenants: observations.length,
      };
    } catch (error) {
      // URL, SQL errors and provider payloads remain private, including auth failures.
      reportOperatorExecutionFailure(
        input.target.sessionId,
        "final_runtime_readiness",
        error,
        undefined,
        {
          stage: "final_runtime_readiness",
          runtimeReadinessStage,
        },
      );
      throw reject();
    }
  };
