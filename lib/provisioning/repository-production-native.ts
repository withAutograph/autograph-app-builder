/* oxlint-disable eslint/no-nested-ternary, sonarjs/no-nested-conditional -- Progress projection retains the four distinct creator states and explicit removal status. */
/* oxlint-disable sonarjs/expression-complexity, react-doctor/server-sequential-independent-await -- Owner authorization is re-read before examining the saved approval; the full configured destination must match. */
/* oxlint-disable unicorn/no-await-expression-member -- These owner-scoped async reads are immediately projected; no mutable state is reused across awaits. */
/* oxlint-disable eslint/no-use-before-define, sonarjs/no-wildcard-import -- Lazy mutually composed callbacks share one request-scoped owner, journal and Drizzle schema. */
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
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
import { createRepositoryProductionCreator } from "./repository-production-creator";
import { createRepositoryProductionHandler } from "./repository-production-dispatcher";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import { readRepositoryProductionConfiguration } from "./repository-production-configuration";
import {
  repositoryProductionApprovalInput,
  repositoryProductionApprovalDigest,
} from "./repository-production-approval";
import {
  initialRepositoryProductionRecord,
  repositoryProductionScopeSchema,
  repositoryProductionRecordSchema,
  repositoryProductionOperationRef,
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
import { createRepositoryProductionWorkers } from "./repository-production-workers";
import { createRepositoryProductionSetup } from "./repository-production-setup";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";
import { createRepositoryProductionConnectionReader } from "./repository-production-connections";
import { createRepositoryProductionRuntimeBinding } from "./repository-production-runtime-binding";

/** Production composition opens only the ordinary Builder store and explicit repository profile. */
const defined = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("repository_production_state_unavailable");
  }
  return value;
};
export const createRepositoryProductionNativeHandler =
  (environment: Readonly<Record<string, string | undefined>> = process.env) =>
  async (request: Request): Promise<Response> => {
    const configuration = readRepositoryProductionConfiguration(environment);
    const settings = readHostedOperatorOwnerReaderConfiguration(environment);
    const keyring = readVercelTokenKeyringEnvironment(environment);
    const client = postgres(settings.databaseUrl, hostedRuntimePostgresOptions);
    const database = drizzle(client, { schema });
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
      const records = new Map<string, Awaited<ReturnType<typeof resolve>>>();
      const key = (scope: RepositoryProductionScope) => repositoryProductionOperationRef(scope);
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
        if (!source || !spec || spec.appId !== owner.appId) {
          throw new Error("repository_production_source_unavailable");
        }
        const profile = configuration.repositories.find(
          (item) =>
            item.workspaceId === owner.ownerContext.authority.workspaceId &&
            item.repositoryId === source.repository.repositoryId &&
            item.repositoryFullName === `${source.repository.owner}/${source.repository.name}`,
        );
        if (!profile) {
          throw new Error("repository_production_scope_denied");
        }
        const assertCurrentOwner = async () => {
          await readSession(owner);
        };
        const artifactContext = {
          authority: owner.ownerContext.authority,
          target: { appId: owner.appId, sessionId: owner.sessionId },
        };
        const selections = createPostgresOperatorArtifactSelections({
          database,
          assertCurrentOwner,
        });
        const selection = await selections.read(artifactContext, spec.appSpecDigest);
        const capture = selection
          ? await createOperatorArtifactPublication({
              store: createPostgresOperatorArtifactStore({ database, assertCurrentOwner }),
              assertCurrentOwner,
            }).readGeneratedRelease(artifactContext, selection)
          : undefined;
        const description =
          capture?.description ??
          (await createCapturedAppDescriptionStore({ database, assertCurrentOwner }).read(
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
          sourceSha: selection?.publishedSource?.gitSha ?? source.repository.headSha,
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
        const result = { scope, intent, profile, owner, description, capture, assertCurrentOwner };
        records.set(key(scope), result);
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
        return await resolve({
          appId: scope.appId,
          sessionId: row.record.ownerContext.sessionId,
          ownerContext: row.record.ownerContext,
        });
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
      ) => {
        const known = await current(scope);
        const saved = await store.read(scope);
        return await createRepositoryProductionLease({
          databaseUrl: environment.PROTECTED_RESOURCE_LOCK_DATABASE_URL ?? settings.databaseUrl,
          store,
          intent: saved?.record.intent ?? known.intent,
          assertAuthorized,
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
          database,
          config: keyring,
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
            operator: {
              teamId: configuration.operator.ownerId,
              projectId: configuration.operator.projectId,
              environment: "production",
            },
          },
          keyring,
          builderOrigin,
          authRealm: realm(scope),
          signal: request.signal,
          readCreator: (row) => creator.readCreator(row),
          readGeneratedRelease: async () => {
            const capture = (await current(scope)).capture;
            if (!capture) {
              throw new Error("repository_production_capture_unavailable");
            }
            return capture.files;
          },
          readConnections: (context) =>
            createRepositoryProductionConnectionReader({
              connection: { ...configuration.connection, operator: configuration.operator },
              resources: profile,
              assertCurrent: context.assertCurrent,
              signal: request.signal,
            })(),
          runtimeBinding: createRepositoryProductionRuntimeBinding({
            teamId: configuration.operator.ownerId,
            readCredential,
            signal: request.signal,
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
        effect: "creator-access",
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
        createRepositoryProductionSetup({
          store,
          assertAuthorized,
          withLease: held ? async (_scope, run) => await run(held) : withLease,
          ...workers(scope),
          prepareCreatorIdentity: (context) => creator.prepare(context),
        });
      const creator = createRepositoryProductionCreator({
        builderOrigin,
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
        resume: async (row, originalSessionId) => {
          const originalOwner = row.record.creatorOwnerContext ?? row.record.ownerContext;
          if (originalOwner?.sessionId !== originalSessionId) {
            throw new Error("repository_production_owner_changed");
          }
          await readSession({
            appId: row.record.scope.appId,
            sessionId: originalSessionId,
            ownerContext: originalOwner,
          });
          return await setup(row.record.scope).prepare(row.record.scope, row.record.intent);
        },
      });
      const management = createRepositoryProductionManagement({
        builderOrigin,
        journal: accessJournal,
        withLease,
        readSetup: store.read,
        workers,
        realm,
        appUrl: async (scope) => {
          const known = await current(scope);
          return new URL(
            known.description.app.browserEntryPath ??
              known.description.app.routes[0] ??
              `/${scope.appId}`,
            scope.publicOrigin,
          ).toString();
        },
        roles: async (scope) => (await current(scope)).intent.creatorRoles,
        resolve: async (owner) => {
          const known = await resolve(owner);
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
                  .parse(await authRequest(readContext(row), { action: "list-members" }, true))
                  .some((person) => person.id === row.record.creatorActorId)
              : false;
          return {
            scope: known.scope,
            appName: known.scope.appId,
            organizationName: known.profile.organization.name,
            roles: known.intent.creatorRoles.map((id) => ({ id, label: id })),
            canManage: true,
            appUrl: new URL(
              known.description.app.browserEntryPath ??
                known.description.app.routes[0] ??
                `/${known.scope.appId}`,
              known.scope.publicOrigin,
            ).toString(),
            creator: {
              ...identity,
              status: creatorRemoved
                ? ("failed" as const)
                : state.state === "ready"
                  ? ("ready" as const)
                  : state.state === "identity-required"
                    ? ("sign_in_required" as const)
                    : ("setting_up" as const),
              ...("signInUrl" in state && state.signInUrl !== undefined
                ? { signInUrl: state.signInUrl }
                : {}),
              ...(creatorRemoved
                ? {
                    message:
                      "Your app access was removed. Restore it from People or contact your workspace owner.",
                    retryable: false,
                  }
                : {}),
            },
          };
        },
        assertAuthorized: async (owner, scope) => {
          const resolved = await resolve(owner);
          if (!isDeepStrictEqual(resolved.scope, scope)) {
            throw new Error("repository_production_scope_denied");
          }
        },
        retrySetup: async (scope, effect) => {
          await setup(scope, () => effect.assertCurrent()).prepare(
            scope,
            (await current(scope)).intent,
          );
        },
        renewSignIn: async (scope, effect) => {
          const row = await store.read(scope);
          if (!row) {
            throw new Error("repository_production_setup_required");
          }
          await creator.renew(
            {
              row,
              effect: "creator-access",
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
          const found = await resolve(owner);
          const row = await store.read(found.scope);
          return row
            ? await setup(found.scope).status(found.scope, row.record.intent)
            : { operationRef: key(found.scope), state: "setting-up-data" };
        },
        resolvePlan: async (owner) => {
          const found = await resolve(owner);
          return { scope: found.scope, intent: found.intent };
        },
        resolveSetup: async (owner, approvedByCallId) => {
          const found = await resolve(owner);
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
            Object.values(row.record.effects).some((effect) => effect.state === "pending") &&
            !isDeepStrictEqual(row.record.intent, found.intent)
          ) {
            throw new Error("repository_production_reconciliation_required");
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
          completeInvitation: async (id) => {
            const result = await creator.complete(id);
            if (result === "not-owned") {
              await management.completeInvitation(id);
              return;
            }
            if (result !== "ready") {
              throw new Error("repository_production_pending");
            }
          },
        },
      });
      return await handler(request);
    } finally {
      await client.end({ timeout: 5 });
    }
  };
