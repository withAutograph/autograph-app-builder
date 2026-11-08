import { sameRepositoryProductionSetupEffects } from "./repository-production-intent";
/* oxlint-disable sonarjs/no-nested-functions -- Request-scoped management factories share the held app lease without reacquiring it. */
/* oxlint-disable eslint/no-nested-ternary, sonarjs/no-nested-conditional -- Progress projection retains the four distinct creator states and explicit removal status. */
/* oxlint-disable sonarjs/expression-complexity, react-doctor/server-sequential-independent-await -- Owner authorization is re-read before examining the saved approval; the full configured destination must match. */
/* oxlint-disable unicorn/no-await-expression-member -- These owner-scoped async reads are immediately projected; no mutable state is reused across awaits. */
/* oxlint-disable eslint/no-use-before-define, sonarjs/no-wildcard-import -- Lazy mutually composed callbacks share one request-scoped owner, journal and Drizzle schema. */
import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import * as schema from "../db/schema";
import { hostedRuntimePostgresOptions } from "../db/postgres-connection-policy";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { createPostgresBuilderHandoffStore } from "../handoff/postgres-store";
import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { readVercelTokenKeyringEnvironment } from "../integrations/vercel-installation";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { createRepositoryProductionManagement } from "../app-access/native-management";
import { createPostgresAppAccessOperationStore } from "../app-access/postgres-store";
import { AppAccessError } from "../app-access/errors";
import type { AppAccessCommand } from "../app-access/contracts";
import type { ManagedAppAccess } from "../app-access/management";
import { readRepositoryProductionApproval } from "../eve/private-repository-production-approval";
import { readHostedOperatorOwnerReaderConfiguration } from "./hosted-operator-owner-context";
import {
  createHostedOperatorAppOwnerAuthority,
  readCanonicalAppOwnerSession,
} from "./hosted-operator-owner";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import { createPostgresOperatorArtifactStore } from "./hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import { createNativeTargetApprovalHistoryTransport } from "./native-target-onboarding-deployment";
import { createCapturedAppDescriptionStore } from "./captured-app-description";
import {
  createRepositoryProductionRoleUpdater,
  assertNoConflictingCreatorRoleUpdate,
} from "./repository-production-role-update";
import {
  createRepositoryProductionCreator,
  RepositoryProductionCreatorRecipientLockedError,
} from "./repository-production-creator";
import { createRepositoryProductionAccessUpgrader } from "./repository-production-access-upgrade";
import {
  createRepositoryProductionHandler,
  observeRepositoryProductionCompletion,
  repositoryProductionCompletionPath,
} from "./repository-production-dispatcher";
import type {
  RepositoryProductionCompletion,
  RepositoryProductionRequestOwner,
} from "./repository-production-dispatcher";
import { readRepositoryProductionConfiguration } from "./repository-production-configuration";
import type { RepositoryProductionRepository } from "./repository-production-configuration";
import { createRepositoryProductionManagementResolver } from "./repository-production-management-subject";
import type { RepositoryProductionManagementSubject } from "./repository-production-management-subject";
import { resolveRepositoryProductionDestination } from "./repository-production-destination";
import {
  repositoryProductionApprovalInput,
  repositoryProductionApprovalDigest,
} from "./repository-production-approval";
import {
  initialRepositoryProductionRecord,
  repositoryProductionScopeSchema,
  repositoryProductionRecordSchema,
  repositoryProductionOperationRef,
  repositoryProductionDigest,
} from "./repository-production-contract";
import type {
  RepositoryProductionScope,
  RepositoryProductionIntent,
  RepositoryProductionRow,
} from "./repository-production-contract";
import {
  createPostgresRepositoryProductionStore,
  createRepositoryProductionLease,
} from "./repository-production-store";
import { PhysicalResourceLeaseBusyError } from "./postgres-physical-resource-lease";
import { createRepositoryProductionWorkers } from "./repository-production-workers";
import { createRepositoryProductionSetup } from "./repository-production-setup";
import type {
  RepositoryProductionEffectContext,
  RepositoryProductionSetupPorts,
} from "./repository-production-setup";
import { createRepositoryProductionConnectionReader } from "./repository-production-connections";
import { createRepositoryProductionRuntimeBinding } from "./repository-production-runtime-binding";

const creatorAccessEffect = "creator-access";
const retrySetupAction = "retry-setup";
const listMembersAction = "list-members";
const key = (scope: RepositoryProductionScope) => repositoryProductionOperationRef(scope);

/** Production composition opens only the ordinary Builder store and explicit repository profile. */
const defined = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("repository_production_state_unavailable");
  }
  return value;
};

/** Fresh People writes wait only for real in-flight schema or creator-grant effects. */
export const assertNoConflictingProductionSetup = (input: {
  row: RepositoryProductionRow | undefined;
  command?: AppAccessCommand;
  pendingCommandIds: readonly string[];
}) => {
  const effects = input.row?.record.effects;
  if (
    effects?.["creator-access"].state !== "pending" &&
    effects?.["install-schema"].state !== "pending"
  ) {
    return;
  }
  const { command } = input;
  if (
    command?.action === retrySetupAction ||
    command?.action === "renew-sign-in" ||
    command?.action === "choose-creator-account"
  ) {
    return;
  }
  if (command !== undefined && input.pendingCommandIds.includes(command.clientRequestId)) {
    return;
  }
  throw new AppAccessError("app_access_unknown");
};

/** Setup locks authorize the requested approved revision before its journal intent is advanced. */
export const createRepositoryProductionIntentBoundSetup = (
  ports: Omit<RepositoryProductionSetupPorts, "withLease">,
  acquire: <T>(
    scope: RepositoryProductionScope,
    intent: RepositoryProductionIntent,
    run: (assertCurrent: () => Promise<void>) => Promise<T>,
  ) => Promise<T>,
) => {
  const forIntent = (intent: RepositoryProductionIntent) =>
    createRepositoryProductionSetup({
      ...ports,
      withLease: async (scope, run) => await acquire(scope, intent, run),
    });
  return {
    prepare: async (scope: RepositoryProductionScope, intent: RepositoryProductionIntent) =>
      await forIntent(intent).prepare(scope, intent),
    status: async (scope: RepositoryProductionScope, intent: RepositoryProductionIntent) =>
      await forIntent(intent).status(scope, intent),
    resume: async (scope: RepositoryProductionScope, intent: RepositoryProductionIntent) => {
      const setup = forIntent(intent);
      const status = await setup.status(scope, intent);
      return status.state === "ready" ? status : await setup.prepare(scope, intent);
    },
  };
};

export const completeRepositoryProductionInvitation = async (input: {
  creator: () => Promise<"not-owned" | "ready" | "pending">;
  invitee: () => Promise<void>;
}): Promise<RepositoryProductionCompletion> => {
  try {
    const result = await input.creator();
    if (result !== "not-owned") {
      return result;
    }
    await input.invitee();
    return "ready";
  } catch (error) {
    if (error instanceof PhysicalResourceLeaseBusyError) {
      return "pending";
    }
    throw error;
  }
};
export const createRepositoryProductionNativeHandler =
  (
    environment: Readonly<Record<string, string | undefined>> = process.env,
    waitUntil?: (task: Promise<void>) => void,
  ) =>
  async (request: Request): Promise<Response> => {
    const configuration = readRepositoryProductionConfiguration(environment);
    const settings = readHostedOperatorOwnerReaderConfiguration(environment);
    const keyring = readVercelTokenKeyringEnvironment(environment);
    const client = postgres(settings.databaseUrl, hostedRuntimePostgresOptions);
    const database = drizzle(client, { schema });
    const effectSignal =
      waitUntil && new URL(request.url).pathname === repositoryProductionCompletionPath
        ? AbortSignal.timeout(20 * 60 * 1000)
        : request.signal;
    let deferredCleanup = false;
    const dispose = () => client.end({ timeout: 5 });
    try {
      const sessions = createPostgresHostedEveStore(database);
      const membership = createPostgresPreviewOrganizationAuthority(database, {
        audience: settings.resource,
        issuer: settings.issuer,
      });
      const ownerDeps = {
        eve: sessions,
        handoffs: createPostgresBuilderHandoffStore(database),
        workloadPolicy: configuration.builderWorkload,
        membership: {
          isMember: async ({
            principal,
            workspaceId,
          }: {
            principal: { audience: string; issuer: string; ownerUserId: string };
            workspaceId: string;
          }) => await membership.isActiveMember({ ...principal, workspaceId }),
        },
      };
      const ownerAuthority = createHostedOperatorAppOwnerAuthority(ownerDeps);
      const store = createPostgresRepositoryProductionStore(database);
      const accessJournal = createPostgresAppAccessOperationStore(database);
      const builderOrigin = new URL(settings.issuer).origin;
      const records = new Map<
        string,
        RepositoryProductionManagementSubject<RepositoryProductionRepository>
      >();
      const readSession = (owner: RepositoryProductionRequestOwner) =>
        readCanonicalAppOwnerSession(ownerDeps, {
          authority: owner.ownerContext.authority,
          ownerContext: owner.ownerContext,
          target: { appId: owner.appId, sessionId: owner.sessionId },
        });
      const configured = (scope: RepositoryProductionScope) => {
        const found = configuration.repositories.find(
          (item) =>
            item.workspaceId === scope.authority.workspaceId &&
            item.repositoryId === scope.repositoryId &&
            item.repositoryFullName === scope.repositoryFullName &&
            item.organization.id === scope.organizationId &&
            item.projectId === scope.projectId &&
            item.publicOrigin === scope.publicOrigin,
        );
        if (!found) {
          throw new Error("repository_production_scope_denied");
        }
        return found;
      };
      const resolve = async (owner: RepositoryProductionRequestOwner) => {
        const session = await readSession(owner);
        const decision = session.privateBuildDecision;
        const source = decision?.existingRepositorySource;
        const spec = decision?.currentSpec;
        if (!spec || spec.appId !== owner.appId) {
          throw new Error("repository_production_source_unavailable");
        }
        const assertCurrentOwner = async () => {
          await readSession(owner);
        };
        const artifactContext = {
          authority: owner.ownerContext.authority,
          target: { appId: owner.appId, sessionId: owner.sessionId },
        };
        const selections = createPostgresOperatorArtifactSelections({
          assertCurrentOwner,
          database,
        });
        const [selection, destination] = await Promise.all([
          selections.read(artifactContext, spec.appSpecDigest),
          selections.readDestination?.(artifactContext, spec.appSpecDigest),
        ]);
        const { workspaceId } = owner.ownerContext.authority;
        const { appId } = owner;
        const { appSpecDigest } = spec;
        const { repositories } = configuration;
        const { profile, sourceSha } = resolveRepositoryProductionDestination({
          appId,
          appSpecDigest,
          destination,
          repositories,
          selection,
          source,
          workspaceId,
        });
        const capture = selection
          ? await createOperatorArtifactPublication({
              assertCurrentOwner,
              store: createPostgresOperatorArtifactStore({ assertCurrentOwner, database }),
            }).readGeneratedRelease(artifactContext, selection)
          : undefined;
        const description =
          capture?.description ??
          (await createCapturedAppDescriptionStore({ assertCurrentOwner, database }).read(
            artifactContext,
            spec.appSpecDigest,
          ));
        if (
          !description ||
          description.app.id !== owner.appId ||
          (description.backend.kind === "generated-postgres" && !selection)
        ) {
          throw new Error("repository_production_capture_unavailable");
        }
        const scope = repositoryProductionScopeSchema.parse({
          authority: owner.ownerContext.authority,
          appId: owner.appId,
          repositoryId: profile.repositoryId,
          repositoryFullName: profile.repositoryFullName,
          projectId: profile.projectId,
          organizationId: profile.organization.id,
          publicOrigin: profile.publicOrigin,
          environment: "production",
        });
        const intent: RepositoryProductionIntent = {
          sessionId: owner.sessionId,
          sourceSha,
          creatorRoles:
            description.backend.kind === "generated-postgres" ? description.backend.roles : [],
          storage:
            description.backend.kind === "static"
              ? { kind: "none" }
              : {
                  kind: "postgres",
                  releaseId: defined(selection).releaseId,
                  artifactRef: defined(selection).artifactRef,
                  manifestSha256: defined(selection).manifestSha256,
                  databaseEnvironment: description.backend.runtime.databaseEnvironment,
                },
        };
        const existing = await store.read(scope);
        if (existing?.record.intent.creatorEmail !== undefined) {
          intent.creatorEmail = existing.record.intent.creatorEmail;
        }
        const result = {
          assertCurrentOwner,
          capture,
          description,
          intent,
          owner,
          profile,
          scope,
          publishedDescription:
            selection?.publishedSource !== undefined || destination !== undefined,
        };
        records.set(key(scope), result);
        return result;
      };
      const resolveManagement = createRepositoryProductionManagementResolver({
        repositories: configuration.repositories,
        readSession: async (owner) => {
          await readSession(owner);
        },
        store,
        resolveCurrent: resolve,
        readCapture: async (artifactContext, storage, assertCurrentOwner) => {
          const selections = createPostgresOperatorArtifactSelections({
            assertCurrentOwner,
            database,
          });
          const selection = await selections.readExact?.(artifactContext, {
            artifactRef: storage.artifactRef,
          });
          if (
            !selection ||
            selection.releaseId !== storage.releaseId ||
            selection.manifestSha256 !== storage.manifestSha256
          ) {
            throw new Error("repository_production_capture_unavailable");
          }
          return await createOperatorArtifactPublication({
            assertCurrentOwner,
            store: createPostgresOperatorArtifactStore({ assertCurrentOwner, database }),
          }).readGeneratedRelease(artifactContext, selection);
        },
      });
      const managed = async (owner: RepositoryProductionRequestOwner) => {
        const result = await resolveManagement(owner);
        records.set(key(result.scope), result);
        return result;
      };
      const current = async (scope: RepositoryProductionScope) => {
        const known = records.get(key(scope));
        if (known) {
          return known;
        }
        const row = await store.read(scope);
        if (!row?.record.ownerContext) {
          throw new Error("repository_production_owner_unavailable");
        }
        const { appId } = scope;
        const { sessionId } = row.record.ownerContext;
        const { ownerContext } = row.record;
        return await managed({ appId, ownerContext, sessionId });
      };
      const assertAuthorized = async (
        scope: RepositoryProductionScope,
        intent: RepositoryProductionIntent,
      ) => {
        configured(scope);
        const known = await current(scope);
        await readSession(known.owner);
        if (!isDeepStrictEqual(scope, known.scope)) {
          throw new Error("repository_production_owner_changed");
        }
        const approval = (await store.read(scope))?.record.approval;
        if (
          !approval ||
          approval.planDigest !== repositoryProductionApprovalDigest(scope, intent)
        ) {
          throw new Error("repository_production_approval_required");
        }
      };
      const withLease = async <T>(
        scope: RepositoryProductionScope,
        run: (assertCurrent: () => Promise<void>) => Promise<T>,
        requestedIntent?: RepositoryProductionIntent,
        tryAcquire = false,
      ) => {
        const known = await current(scope);
        const saved = await store.read(scope);
        return await createRepositoryProductionLease({
          assertAuthorized,
          databaseUrl: environment.PROTECTED_RESOURCE_LOCK_DATABASE_URL ?? settings.databaseUrl,
          intent: requestedIntent ?? saved?.record.intent ?? known.intent,
          store,
          tryAcquire,
        })(scope, run);
      };
      const realm = (scope: RepositoryProductionScope) => {
        const profile = configured(scope);
        const resource = profile.authResource;
        return {
          version: 1,
          kind: "managed-production-realm-v1",
          workspaceId: scope.authority.workspaceId,
          repositoryId: scope.repositoryId,
          repositoryFullName: scope.repositoryFullName,
          authResourceId: resource.resourceId,
          authorizedOrganizationIds: [scope.organizationId],
          publicOrigin: scope.publicOrigin,
          project: {
            projectId: profile.authWorkload.projectId,
            ownerId: profile.authWorkload.ownerId,
            environment: "production",
          },
          resource: {
            version: 1,
            environment: "production",
            hostname: profile.neon.endpoint,
            port: 5432,
            database: resource.database,
            schema: "public",
            runtimeRole: resource.runtimeRole,
            migratorRole: resource.migratorRole,
            neon: { projectId: profile.neon.projectId, branchId: profile.neon.branchId },
          },
        };
      };
      const readCredential = async () => {
        const token = await readActiveVercelInstallationToken({
          config: keyring,
          database,
          ...configuration.vercelCredential,
        });
        if (!token || token.binding.scopeId !== configuration.operator.ownerId) {
          throw new Error("repository_production_provider_access_required");
        }
        return token.token;
      };
      const workerCache = new Map<string, ReturnType<typeof createRepositoryProductionWorkers>>();
      const workers = (scope: RepositoryProductionScope) => {
        const existing = workerCache.get(key(scope));
        if (existing) {
          return existing;
        }
        const profile = configured(scope);
        const composed = createRepositoryProductionWorkers({
          profile: {
            sandbox: { ...configuration.sandbox, workers: {} },
            workers: configuration.workers,
            neon: profile.neon,
            authResource: profile.authResource,
            authOperatorRole: profile.authOperatorRole,
            operator: {
              teamId: configuration.operator.ownerId,
              projectId: configuration.operator.projectId,
              environment: "production",
            },
          },
          keyring,
          builderOrigin,
          authRealm: realm(scope),
          signal: effectSignal,
          readCreator: (row) => creator.readCreator(row),
          readGeneratedRelease: async (row) => {
            if (row.record.intent.storage.kind !== "postgres") {
              throw new Error("repository_production_capture_unavailable");
            }
            const known = await current(scope);
            const artifactContext = {
              authority: scope.authority,
              target: { appId: scope.appId, sessionId: row.record.intent.sessionId },
            };
            const selections = createPostgresOperatorArtifactSelections({
              assertCurrentOwner: known.assertCurrentOwner,
              database,
            });
            const selection = await selections.readExact?.(artifactContext, {
              artifactRef: row.record.intent.storage.artifactRef,
            });
            if (!selection) {
              throw new Error("repository_production_capture_unavailable");
            }
            const artifactStore = createPostgresOperatorArtifactStore({
              assertCurrentOwner: known.assertCurrentOwner,
              database,
            });
            return (
              await createOperatorArtifactPublication({
                assertCurrentOwner: known.assertCurrentOwner,
                store: artifactStore,
              }).readGeneratedRelease(artifactContext, selection)
            ).files;
          },
          readConnections: (context) =>
            createRepositoryProductionConnectionReader({
              connection: {
                ...defined(profile.connection ?? configuration.connection),
                operator: configuration.operator,
              },
              resources: profile,
              environment,
              assertCurrent: context.assertCurrent,
              signal: effectSignal,
            })(),
          runtimeBinding: createRepositoryProductionRuntimeBinding({
            installationId: configuration.vercelCredential.installationId,
            runtimeEndpoint: { hostname: profile.neon.endpoint, port: 5432 },
            readCredential,
            signal: effectSignal,
            teamId: configuration.operator.ownerId,
          }),
          frontendAccess: {
            apply: () =>
              Promise.reject(new Error("repository_production_managed_identity_required")),
            reconcile: () =>
              Promise.reject(new Error("repository_production_managed_identity_required")),
          },
        });
        workerCache.set(key(scope), composed);
        return composed;
      };
      const readContext = (row: RepositoryProductionRow): RepositoryProductionEffectContext => ({
        row,
        effect: creatorAccessEffect,
        assertCurrent: async () => {
          await (await current(row.record.scope)).assertCurrentOwner();
        },
        checkpoint: () => Promise.reject(new Error("read_only")),
      });
      const authRequest = async (
        context: RepositoryProductionEffectContext,
        operation: z.infer<ReturnType<typeof z.json>>,
        readOnly: boolean,
      ) => {
        const response = await workers(context.row.record.scope).invokeAuthManagement(
          context,
          {
            version: 1,
            realm: realm(context.row.record.scope),
            builderOrigin,
            scope: {
              appId: context.row.record.scope.appId,
              organizationId: context.row.record.scope.organizationId,
            },
            request: operation,
          },
          readOnly,
        );
        return z.object({ result: z.unknown() }).parse(response).result;
      };
      const setup = (scope: RepositoryProductionScope, held?: () => Promise<void>) =>
        createRepositoryProductionIntentBoundSetup(
          {
            store,
            assertAuthorized,
            ...workers(scope),
            prepareCreatorIdentity: (context) => creator.prepare(context),
            reconcileAppAccessUpgrade: createRepositoryProductionAccessUpgrader({
              execute: async (context, command) => {
                await managementFor(() => context.assertCurrent(), command, true).execute(
                  (await current(scope)).owner,
                  command,
                );
              },
              readMembers: async (context) =>
                z
                  .array(z.object({ id: z.string(), roles: z.array(z.string()) }))
                  .parse(await authRequest(context, { action: listMembersAction }, true)),
            }),
            reconcileCreatorRoles: createRepositoryProductionRoleUpdater({
              execute: async (context, command) => {
                await managementFor(() => context.assertCurrent(), command, true).execute(
                  (await current(scope)).owner,
                  command,
                );
              },
              readMembers: async (context) =>
                z
                  .array(z.object({ id: z.string() }))
                  .parse(await authRequest(context, { action: listMembersAction }, true)),
            }),
          },
          async (target, intent, run) =>
            held ? await run(held) : await withLease(target, run, intent),
        );
      const creator = createRepositoryProductionCreator({
        builderOrigin,
        realmDigest: (scope) => {
          const configuredRealm = realm(scope);
          return repositoryProductionDigest({
            publicOrigin: configuredRealm.publicOrigin,
            project: configuredRealm.project,
            authResourceId: configuredRealm.authResourceId,
            resource: configuredRealm.resource,
          });
        },
        async *linkedCreatorCandidates(row) {
          const { authority } = row.record.scope;
          let cursor: string | undefined;
          for (;;) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- The next page depends on this page's final journal key.
            const candidates = await database
              .select()
              .from(schema.builderProvisioningJournals)
              .where(
                and(
                  eq(schema.builderProvisioningJournals.issuer, authority.issuer),
                  eq(schema.builderProvisioningJournals.audience, authority.audience),
                  eq(schema.builderProvisioningJournals.workspaceId, authority.workspaceId),
                  eq(schema.builderProvisioningJournals.ownerUserId, authority.ownerUserId),
                  sql`${schema.builderProvisioningJournals.record}->>'kind' = 'repository-production-setup-v1'`,
                  sql`${schema.builderProvisioningJournals.record}->'effects'->'creator-access'->>'state' = 'applied'`,
                  cursor === undefined
                    ? undefined
                    : gt(schema.builderProvisioningJournals.requestId, cursor),
                ),
              )
              .orderBy(schema.builderProvisioningJournals.requestId)
              .limit(100);
            if (candidates.length === 0) {
              return;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- Read each bounded page before advancing its cursor.
            const saved = await Promise.all(
              candidates.map(async (candidate) => {
                const record = repositoryProductionRecordSchema.parse(candidate.record);
                return await store.read(record.scope);
              }),
            );
            for (const candidate of saved) {
              if (candidate !== undefined) {
                yield candidate;
              }
            }
            cursor = candidates.at(-1)?.requestId;
          }
        },
        readCurrent: store.read,
        readOwner: async (row) => {
          await (await current(row.record.scope)).assertCurrentOwner();
          const [person] = await database
            .select({ email: schema.user.email, verified: schema.user.emailVerified })
            .from(schema.user)
            .where(eq(schema.user.id, row.record.scope.authority.ownerUserId))
            .limit(1);
          if (!person?.verified) {
            throw new Error("repository_production_verified_owner_required");
          }
          return { email: person.email };
        },
        findInvitation: async (id) => {
          const rows = await database
            .select()
            .from(schema.builderProvisioningJournals)
            .where(
              and(
                eq(schema.builderProvisioningJournals.requestId, id),
                sql`${schema.builderProvisioningJournals.record}->>'kind' = 'repository-production-setup-v1'`,
              ),
            )
            .limit(2);
          if (rows.length !== 1) {
            // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence is the explicit optional-store result.
            return undefined;
          }
          const record = repositoryProductionRecordSchema.parse(rows[0].record);
          return await store.read(record.scope);
        },
        readInvitation: (row, id) =>
          authRequest(readContext(row), { action: "read", invitationId: id }, true),
        invokeAuth: (context, operation) => authRequest(context, operation, false),
        assertAuthorized: (row) => assertAuthorized(row.record.scope, row.record.intent),
        withCompletionLease: async (row, run) =>
          await withLease(row.record.scope, run, row.record.intent, true),
        resume: async (row, originalSessionId, assertCurrent) => {
          const originalOwner = row.record.creatorOwnerContext ?? row.record.ownerContext;
          if (originalOwner?.sessionId !== originalSessionId) {
            throw new Error("repository_production_owner_changed");
          }
          await readSession({
            appId: row.record.scope.appId,
            ownerContext: originalOwner,
            sessionId: originalSessionId,
          });
          await assertCurrent();
          return await setup(row.record.scope, assertCurrent).resume(
            row.record.scope,
            row.record.intent,
          );
        },
      });
      const managementFor = (
        held?: () => Promise<void>,
        command?: AppAccessCommand,
        roleUpdate = false,
        automaticCompletion = false,
      ) =>
        createRepositoryProductionManagement({
          builderOrigin,
          journal: accessJournal,
          withLease: held
            ? async (_scope, run) => await run(held)
            : async (scope, run) => await withLease(scope, run, undefined, automaticCompletion),
          readSetup: store.read,
          workers,
          realm,
          appUrl: async (scope) => {
            const known = await current(scope);
            if (!known.description) {
              throw new AppAccessError("app_access_unavailable");
            }
            return new URL(
              known.description.app.browserEntryPath ??
                known.description.app.routes[0] ??
                `/${scope.appId}`,
              scope.publicOrigin,
            ).toString();
          },
          roles: async (scope) =>
            (await store.read(scope))?.record.intent.creatorRoles ??
            (await current(scope)).intent.creatorRoles,
          resolve: async (owner) => {
            const known = await managed(owner);
            const row = await store.read(known.scope);
            const state = row
              ? await setup(known.scope).status(known.scope, row.record.intent)
              : { state: "checking-access" as const };
            const identity = row ? await creator.describe(row) : undefined;
            const creatorRemoved =
              row?.record.effects["creator-access"].state === "applied" &&
              row.record.creatorActorId !== undefined
                ? !z
                    .array(z.object({ id: z.string() }))
                    .parse(await authRequest(readContext(row), { action: listMembersAction }, true))
                    .some((person) => person.id === row.record.creatorActorId)
                : false;
            const resolved: ManagedAppAccess = {
              scope: known.scope,
              appName: known.scope.appId,
              organizationName: known.profile.organization.name,
              roles: (row?.record.intent.creatorRoles ?? known.intent.creatorRoles).map((id) => ({
                id,
                label: id,
              })),
              canManage: true,
              ...(known.description
                ? {
                    appUrl: new URL(
                      known.description.app.browserEntryPath ??
                        known.description.app.routes[0] ??
                        `/${known.scope.appId}`,
                      known.scope.publicOrigin,
                    ).toString(),
                  }
                : {}),
              creator: {
                ...identity,
                status: creatorRemoved
                  ? ("failed" as const)
                  : identity?.status === "failed"
                    ? ("failed" as const)
                    : state.state === "ready"
                      ? ("ready" as const)
                      : state.state === "identity-required"
                        ? ("sign_in_required" as const)
                        : ("setting_up" as const),
              },
            };
            if ("signInUrl" in state && state.signInUrl !== undefined) {
              resolved.creator.signInUrl = state.signInUrl;
            }
            if (creatorRemoved) {
              resolved.creator.message =
                "Your app access was removed. Restore it from People or contact your workspace owner.";
              resolved.creator.retryable = false;
            }
            return resolved;
          },
          assertAuthorized: async (owner, scope, mutating) => {
            const resolved = await managed(owner);
            if (!isDeepStrictEqual(resolved.scope, scope)) {
              throw new Error("repository_production_scope_denied");
            }
            if (mutating && !roleUpdate) {
              const row = await store.read(scope);
              const commandId = command?.clientRequestId;
              const pendingCommandIds = (await accessJournal.pending(scope)).map(
                (item) => item.record.command.clientRequestId,
              );
              const state = { commandId, pendingCommandIds, row };
              assertNoConflictingProductionSetup({ ...state, command });
              if (
                command?.action !== retrySetupAction &&
                command?.action !== "renew-sign-in" &&
                command?.action !== "choose-creator-account"
              ) {
                assertNoConflictingCreatorRoleUpdate(state);
              }
            }
          },
          retrySetup: async (scope, effect) => {
            await setup(scope, () => effect.assertCurrent()).prepare(
              scope,
              (await current(scope)).intent,
            );
          },
          chooseCreatorAccount: async (scope, email, effect) => {
            const row = await store.read(scope);
            if (!row) {
              throw new Error("repository_production_setup_required");
            }
            try {
              await creator.chooseRecipient(
                {
                  row,
                  effect: creatorAccessEffect,
                  assertCurrent: effect.assertCurrent,
                  checkpoint: async (value) => {
                    await effect.assertCurrent();
                    const saved = await store.read(scope);
                    if (
                      !saved ||
                      !(await store.compareAndSet(saved, {
                        ...saved.record,
                        workerCheckpoints: [...saved.record.workerCheckpoints, value],
                      }))
                    ) {
                      throw new Error("repository_production_conflict");
                    }
                  },
                },
                email,
                effect.operationRef,
              );
            } catch (error) {
              if (error instanceof RepositoryProductionCreatorRecipientLockedError) {
                return "rejected";
              }
              throw error;
            }
            await setup(scope, effect.assertCurrent).prepare(scope, row.record.intent);
            return "applied";
          },
          renewSignIn: async (scope, effect) => {
            const row = await store.read(scope);
            if (!row) {
              throw new Error("repository_production_setup_required");
            }
            await creator.renew(
              {
                row,
                effect: creatorAccessEffect,
                assertCurrent: () => effect.assertCurrent(),
                checkpoint: async (value) => {
                  const currentRow = await store.read(scope);
                  if (
                    !currentRow ||
                    !(await store.compareAndSet(currentRow, {
                      ...currentRow.record,
                      workerCheckpoints: [...currentRow.record.workerCheckpoints, value],
                    }))
                  ) {
                    throw new Error("repository_production_conflict");
                  }
                },
              },
              effect.operationRef,
            );
          },
        });
      const management = managementFor();
      const selectCreatorEmail = async (
        found: Awaited<ReturnType<typeof resolve>>,
        creatorEmail?: string,
      ) => {
        if (creatorEmail === undefined) {
          return;
        }
        const saved = await store.read(found.scope);
        const status = saved ? await creator.describe(saved) : undefined;
        // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- Only explicit account-choice permission permits changing the creator recipient.
        if (status && status.email !== creatorEmail && status.canChooseAccount !== true) {
          throw new Error("repository_production_creator_recipient_locked");
        }
        found.intent = { ...found.intent, creatorEmail };
      };
      const handler = createRepositoryProductionHandler({
        verifyBuilderWorkload: createOperatorWorkloadVerifier(configuration.builderWorkload),
        verifyAuthWorkload: async (callback, invitationId) => {
          const access = await accessJournal.findInvitation(invitationId);
          const setupRows = access
            ? []
            : await database
                .select()
                .from(schema.builderProvisioningJournals)
                .where(
                  and(
                    eq(schema.builderProvisioningJournals.requestId, invitationId),
                    sql`${schema.builderProvisioningJournals.record}->>'kind' = 'repository-production-setup-v1'`,
                  ),
                )
                .limit(2);
          const scope =
            access?.record.scope ??
            (setupRows.length === 1
              ? repositoryProductionRecordSchema.parse(setupRows[0].record).scope
              : undefined);
          if (!scope) {
            throw new Error("repository_production_invitation_unknown");
          }
          await createOperatorWorkloadVerifier(configured(scope).authWorkload)(callback);
        },
        readSetup: async (owner) => {
          const found = await managed(owner);
          const row = await store.read(found.scope);
          return row
            ? await setup(found.scope).status(found.scope, row.record.intent)
            : { operationRef: key(found.scope), state: "setting-up-data" };
        },
        resolvePlan: async (owner, creatorEmail) => {
          const found = await resolve(owner);
          const saved = await store.read(found.scope);
          const selected = creatorEmail ?? (saved ? await creator.readRecipient(saved) : undefined);
          await selectCreatorEmail(found, selected);
          return { scope: found.scope, intent: found.intent };
        },
        resolveSetup: async (owner, approvedByCallId, creatorEmail) => {
          const found = await resolve(owner);
          await selectCreatorEmail(found, creatorEmail);
          const transport = createNativeTargetApprovalHistoryTransport({
            builderOrigin,
            owner: {
              authority: owner.ownerContext.authority,
              publicSessionId: owner.sessionId,
              adapterSessionId: owner.ownerContext.adapterSessionId,
              adapterGeneration: owner.ownerContext.adapterGeneration,
              historyOwner: owner.ownerContext,
            },
            appId: owner.appId,
            workload: {
              authorization: request.headers.get("authorization"),
              signal: request.signal,
            },
            assertCanonicalAppOwner: ownerAuthority.assertCanonicalAppOwner,
          });
          if (!transport.observePrivateHistory) {
            throw new Error("repository_production_approval_unavailable");
          }
          const approved = await readRepositoryProductionApproval({
            plan: repositoryProductionApprovalInput(found.scope, found.intent),
            callId: approvedByCallId,
            owner: owner.ownerContext,
            assertOwner: found.assertCurrentOwner,
            readHistory: (startIndex, onEvent) =>
              defined(transport.observePrivateHistory)({
                principal: owner.ownerContext.principal,
                adapterSessionId: owner.ownerContext.adapterSessionId,
                sessionId: owner.sessionId,
                startIndex,
                onEvent,
              }),
          });
          if (!approved) {
            throw new Error("repository_production_approval_required");
          }
          const approval = {
            ...approved,
            planDigest: repositoryProductionApprovalDigest(found.scope, found.intent),
          };
          // Retain proof before provider work; the CAS cannot move the app or overwrite any worker state.
          const row =
            (await store.read(found.scope)) ??
            (await store.reserve(initialRepositoryProductionRecord(found.scope, found.intent)));
          if (
            (row.record.creatorRoleUpdate?.state === "pending" ||
              row.record.appAccessUpgrade?.state === "pending" ||
              Object.values(row.record.effects).some((effect) => effect.state === "pending")) &&
            !sameRepositoryProductionSetupEffects(row.record.intent, found.intent)
          ) {
            throw new Error("repository_production_reconciliation_required");
          }
          if (
            !sameRepositoryProductionSetupEffects(row.record.intent, found.intent) &&
            (await accessJournal.pending(found.scope)).length > 0
          ) {
            throw new Error("repository_production_access_reconciliation_required");
          }
          if (
            !(await store.compareAndSet(row, {
              ...row.record,
              ownerContext: owner.ownerContext,
              creatorOwnerContext: row.record.creatorOwnerContext ?? owner.ownerContext,
              approval,
            }))
          ) {
            throw new Error("repository_production_conflict");
          }
          return { scope: found.scope, intent: found.intent, setup: setup(found.scope) };
        },
        management: {
          ...management,
          execute: async (owner, command) => {
            const found = await managed(owner);
            const row = await store.read(found.scope);
            if (
              command.action === retrySetupAction &&
              (row?.record.creatorRoleUpdate?.state === "pending" ||
                row?.record.appAccessUpgrade?.state === "pending")
            ) {
              await setup(found.scope).prepare(found.scope, row.record.intent);
              return await management.read(owner);
            }
            return await managementFor(undefined, command).execute(owner, command);
          },
          completeInvitation: async (id) => {
            const complete = async () =>
              await completeRepositoryProductionInvitation({
                creator: async () => await creator.complete(id),
                invitee: async () => {
                  await managementFor(undefined, undefined, false, true).completeInvitation(id);
                },
              });
            if (!waitUntil) {
              return await complete();
            }
            deferredCleanup = true;
            return await observeRepositoryProductionCompletion(complete(), waitUntil, dispose);
          },
        },
      });
      return await handler(request);
    } finally {
      if (!deferredCleanup) {
        await dispose();
      }
    }
  };
