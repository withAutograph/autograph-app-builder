/* oxlint-disable react-doctor/server-sequential-independent-await -- Fixed metadata statements share one repeatable-read transaction, not independent provider executions. */
import postgres from "postgres";
import { z } from "zod";
import { privateMaintenanceUrl, scopeSchema } from "./hosted-operator-native-preview-neon";
import { readAppRuntimeSnapshot } from "./hosted-operator-app-readiness";
import type {
  ActorBindingRecordReadback,
  OperatorActorBindingScope,
} from "./hosted-operator-app-readiness";
import type {
  RepositoryProductionScope,
  RepositoryProductionResource,
} from "./repository-production-contract";
import type { RepositoryProductionWorkerProfile } from "./repository-production-workers";

const generation = z
  .union([z.number(), z.string().regex(/^[0-9]+$/u)])
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const tuple = z.object({ actorId: z.string(), appId: z.string(), organizationId: z.string() });
const authSnapshotSchema = z.object({
  identity: z.object({ role: z.string(), database: z.string() }),
  member: z.boolean(),
  entitled: z.boolean(),
  grants: z.array(tuple.extend({ role: z.string(), active: z.boolean(), generation })),
  admission: z.array(
    tuple.extend({
      workspaceId: z.string(),
      roles: z.array(z.string()),
      active: z.boolean(),
      generation,
    }),
  ),
});
type AuthSnapshot = z.infer<typeof authSnapshotSchema>;
type Profile = Pick<
  RepositoryProductionWorkerProfile,
  "neon" | "authResource" | "authOperatorRole"
>;
export interface AcceptedInviteeReadbackInput {
  scope: RepositoryProductionScope;
  actorId: string;
  roles: readonly string[];
  controlGeneration: number;
  profile: Profile;
  authUrl: string;
  runtime?: { url: string; resource: RepositoryProductionResource };
  assertCurrent: () => Promise<void>;
  signal: AbortSignal;
}

/** Fixed Auth metadata only, using the already verified protected operator connection. */
export const readProductionInviteeAuthSnapshot = async (
  url: string,
  scope: RepositoryProductionScope,
  actorId: string,
): Promise<AuthSnapshot> => {
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {
      /* Driver notices may contain private connection details. */
    },
  });
  try {
    return await sql.begin("isolation level repeatable read read only", async (tx) => {
      const identities = await tx`select current_user as role,current_database() as database`;
      const membership = await tx.unsafe(
        `select exists(select 1 from public.member where "organizationId"=$1 and "userId"=$2) as member,
          exists(select 1 from public.organization where id=$1 and "appIds" @> jsonb_build_array($3::text)) as entitled`,
        [scope.organizationId, actorId, scope.appId],
      );
      const grants = await tx.unsafe(
        `select "actorId","appId","organizationId",role,active,fence_generation::text as generation
           from public.app_actor_assignment where "organizationId"=$1 and "actorId"=$2 and "appId"=$3`,
        [scope.organizationId, actorId, scope.appId],
      );
      const admission = await tx.unsafe(
        `select "actorId","appId","organizationId","workspaceId",roles,active,"fenceGeneration"::text as generation
           from public.app_actor_access where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and "workspaceId"=$4`,
        [scope.organizationId, actorId, scope.appId, scope.authority.workspaceId],
      );
      if (identities.length !== 1 || membership.length !== 1) {
        throw new Error("repository_production_access_readback_unavailable");
      }
      const flags = z.object({ member: z.boolean(), entitled: z.boolean() }).parse(membership[0]);
      return authSnapshotSchema.parse({
        identity: identities[0],
        member: flags.member,
        entitled: flags.entitled,
        grants,
        admission,
      });
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};

const settleRead = async <T>(read: Promise<T>) => {
  try {
    return { ok: true as const, value: await read };
  } catch {
    return { ok: false as const };
  }
};

/** Reconciles accepted access; historical grant generations never replace current control authority. */
export const readAcceptedProductionInviteeAccess = async (
  input: AcceptedInviteeReadbackInput,
  io: {
    readAuth?: typeof readProductionInviteeAuthSnapshot;
    readRuntime?: typeof readAppRuntimeSnapshot;
  } = {},
): Promise<"applied" | "absent" | "unknown"> => {
  const guard = async () => {
    input.signal.throwIfAborted();
    await input.assertCurrent();
    input.signal.throwIfAborted();
  };
  await guard();
  if (
    !Number.isSafeInteger(input.controlGeneration) ||
    input.controlGeneration <= 0 ||
    new Set(input.roles).size !== input.roles.length
  ) {
    return "unknown";
  }
  let authUrl: string;
  let runtimeUrl: string | undefined;
  try {
    const connectionScope = (database: string, role: string) =>
      scopeSchema.parse({
        projectId: input.profile.neon.projectId,
        branchId: input.profile.neon.branchId,
        endpointId: input.profile.neon.endpointId,
        hostname: input.profile.neon.endpoint,
        maintenanceDatabase: database,
        maintenanceRole: role,
      });
    authUrl = privateMaintenanceUrl(
      input.authUrl,
      connectionScope(input.profile.authResource.database, input.profile.authOperatorRole),
    );
    if (input.runtime) {
      runtimeUrl = privateMaintenanceUrl(
        input.runtime.url,
        connectionScope(input.runtime.resource.database, input.runtime.resource.runtimeRole),
      );
    }
  } catch {
    return "unknown";
  }
  const authRead = await settleRead(
    (io.readAuth ?? readProductionInviteeAuthSnapshot)(authUrl, input.scope, input.actorId),
  );
  await guard();
  if (!authRead.ok) {
    return "unknown";
  }
  const decoded = authSnapshotSchema.safeParse(authRead.value);
  if (!decoded.success) {
    return "unknown";
  }
  const auth = decoded.data;
  if (
    auth.identity.role !== input.profile.authOperatorRole ||
    auth.identity.database !== input.profile.authResource.database
  ) {
    return "unknown";
  }
  const sameTuple = (row: z.infer<typeof tuple>) =>
    row.actorId === input.actorId &&
    row.appId === input.scope.appId &&
    row.organizationId === input.scope.organizationId;
  if (
    auth.grants.some((row) => !sameTuple(row)) ||
    auth.admission.some(
      (row) => !sameTuple(row) || row.workspaceId !== input.scope.authority.workspaceId,
    )
  ) {
    return "unknown";
  }
  if (!auth.member || !auth.entitled) {
    return "absent";
  }
  const expected: { role?: string; generation: number }[] = [];
  if (input.roles.length === 0) {
    if (
      auth.admission.length !== 1 ||
      !auth.admission[0]?.active ||
      auth.admission[0].roles.length !== 0
    ) {
      return "absent";
    }
    expected.push({ generation: auth.admission[0].generation });
  } else {
    for (const role of input.roles) {
      const matches = auth.grants.filter((row) => row.role === role);
      if (matches.length > 1) {
        return "unknown";
      }
      if (!matches[0]?.active) {
        return "absent";
      }
      expected.push({ role, generation: matches[0].generation });
    }
  }
  if (expected.some((row) => row.generation <= 0 || row.generation > input.controlGeneration)) {
    return "unknown";
  }
  if (!input.runtime) {
    return "applied";
  }
  const { runtime } = input;
  if (runtimeUrl === undefined) {
    return "unknown";
  }
  const bindings: ActorBindingRecordReadback[] = [];
  const runtimeRead = await settleRead(
    (io.readRuntime ?? readAppRuntimeSnapshot)(runtimeUrl, async (reader) => {
      const identity = await reader.readIdentity();
      const { resource } = runtime;
      const matches = [
        identity.role === resource.runtimeRole,
        identity.login === resource.runtimeRole,
        identity.database === resource.database,
        identity.owner === resource.migratorRole,
        identity.comment === `protected-resource:v1:app_database:${resource.resourceId}:database`,
        identity.project === input.profile.neon.projectId,
        identity.branch === input.profile.neon.branchId,
        identity.endpoint === input.profile.neon.endpointId,
        [
          identity.rolsuper,
          identity.rolcreatedb,
          identity.rolcreaterole,
          identity.rolreplication,
          identity.rolbypassrls,
          identity.privileged_membership,
          identity.owns_public_objects,
          identity.can_create,
          identity.can_temp,
        ].every((flag) => !flag),
      ];
      if (!matches.every(Boolean) || !reader.readActorBindingRecord) {
        throw new Error("repository_production_access_readback_unavailable");
      }
      for (const row of expected) {
        const scope: OperatorActorBindingScope = {
          actorId: input.actorId,
          appId: input.scope.appId,
          organizationId: input.scope.organizationId,
        };
        if (row.role !== undefined) {
          scope.role = row.role;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- All bindings use the same owned runtime transaction and connection.
        bindings.push(await reader.readActorBindingRecord(scope));
      }
      return [];
    }),
  );
  await guard();
  if (!runtimeRead.ok || bindings.length !== expected.length) {
    return "unknown";
  }
  for (let index = 0; index < bindings.length; index += 1) {
    const observed = bindings[index];
    const wanted = expected[index];
    if (observed.status === "absent") {
      return "absent";
    }
    if (observed.status !== "present") {
      return "unknown";
    }
    const { binding } = observed;
    if (!sameTuple(binding) || binding.role !== wanted.role) {
      return "unknown";
    }
    if (!binding.active) {
      return "absent";
    }
    if (
      binding.fenceGeneration <= 0 ||
      binding.fenceGeneration !== wanted.generation ||
      binding.fenceGeneration > input.controlGeneration
    ) {
      return "unknown";
    }
  }
  return "applied";
};
