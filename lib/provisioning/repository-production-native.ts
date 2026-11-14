import { isExistingRepositoryDestination } from "./builder-session-destination-contract";
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
import { tenantKeyFor } from "../eve/hosted-auth";
import { createPostgresGitHubPrEffectStore } from "../repository/postgres-github-pr-effect-store";
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
import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
import type { DirectProductionGrant } from "../agent/direct-production-authorization";
import {
  assertDirectRepositoryProductionApproval,
  readRepositoryProductionApproval,
} from "../eve/private-repository-production-approval";
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
import {
  createRepositoryProductionManagementResolver,
  createRepositoryProductionObservationResolver,
  readRepositoryProductionObservationSession,
  readRepositoryProductionManagementRecord,
} from "./repository-production-management-subject";
import { createRepositoryProductionNativeStatus } from "./repository-production-native-status";
import type { RepositoryProductionNativeStatus } from "./repository-production-native-status-contract";
import {
  createRepositoryProductionCompletionStatus,
  completeRepositoryProductionFromStatus,
} from "./repository-production-completion-status";
import type { RepositoryProductionManagementSubject } from "./repository-production-management-subject";
import { createRepositoryProductionApprovalCheckpoint } from "./repository-production-approval-checkpoint";
import { resolveRepositoryProductionDestination } from "./repository-production-destination";
import {
  repositoryProductionApprovalInput,
  repositoryProductionApprovalDigest,
  assertRepositoryProductionApprovalReference,
} from "./repository-production-approval";
import {
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
import {
  createRepositoryProductionSetup,
  hasPendingRepositoryProductionSchemaRevision,
  repositoryProductionSetupComplete,
  repositoryProductionSchemaEffectsMatch,
  retainedRepositoryProductionSchemaPredecessor,
} from "./repository-production-setup";
import type { RepositoryProductionSchemaActivation } from "./repository-production-delivery";
import { createRepositoryProductionDeliveryStatus } from "./repository-production-delivery-status";
import { canReuseCompletedRepositoryProductionSetup } from "./repository-production-setup-reuse";
import type {
  RepositoryProductionEffectContext,
  RepositoryProductionSetupPorts,
} from "./repository-production-setup";
import { createRepositoryProductionCaptureReader } from "./repository-production-capture";
import { createRepositoryProductionConnectionReader } from "./repository-production-connections";
import { createRepositoryProductionRuntimeBinding } from "./repository-production-runtime-binding";
import { resolveRepositoryProductionSignupIntent } from "./repository-production-signup-policy";
import { createRepositoryProductionSignupNative } from "./repository-production-signup-native";
import { retainRepositoryProductionApproval } from "./repository-production-approval-retention";
import { assertOptionalTextProductionTransition } from "./repository-production-schema-revision";

const creatorAccessEffect = "creator-access";
const schemaRevisionUnverified = () =>
  new Error("repository_production_schema_revision_unverified");
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

const currentRepositoryProductionSchemaGrant = (decision: ApprovedBuildDecision | undefined) => {
  const grant = decision?.directProduction;
  const spec = decision?.currentSpec;
  const { subject } = grant ?? {};
  const current = [
    decision?.workflowPhase === "reviewed",
    subject?.revision?.schemaChange !== undefined,
    subject?.appId === spec?.appId,
    subject?.appSpecDigest === spec?.appSpecDigest,
    subject?.proposalDigest === spec?.proposalDigest,
    subject?.sessionId === spec?.sessionId,
  ].every(Boolean);
  return current ? grant : undefined;
};

export const repositoryProductionSchemaNativeStatusGrantMatches = (
  decision: ApprovedBuildDecision | undefined,
  expectedSchemaGrantDigest: string,
): boolean =>
  currentRepositoryProductionSchemaGrant(decision)?.digest === expectedSchemaGrantDigest;

/** Keep the app's availability and the candidate's completed data setup separate. */
export const projectRepositoryProductionSchemaNativeStatus = async (
  observed: RepositoryProductionNativeStatus,
  includeActivationProof: true | undefined,
  isSchemaReady: () => Promise<boolean>,
  includeSchemaSettlement?: true,
): Promise<RepositoryProductionNativeStatus> => {
  if (includeActivationProof === true) {
    return observed;
  }
  const revisionLive = observed.requestedRevision === "live";
  if (!revisionLive && includeSchemaSettlement !== true) {
    return observed;
  }
  if (await isSchemaReady()) {
    return includeSchemaSettlement === true ? { ...observed, schemaSetupSettled: true } : observed;
  }
  return revisionLive ? { ...observed, requestedRevision: "awaiting-activation" } : observed;
};

export const appliedRepositoryProductionSchemaForGrant = (
  row: RepositoryProductionRow | undefined,
  found: { scope: RepositoryProductionScope; intent: RepositoryProductionIntent },
  grantDigest: string,
): boolean =>
  row !== undefined &&
  [
    isDeepStrictEqual(row.record.scope, found.scope),
    row.record.intent.sessionId === found.intent.sessionId,
    isDeepStrictEqual(row.record.intent.storage, found.intent.storage),
    row.record.effects["install-schema"].state === "applied",
    retainedRepositoryProductionSchemaPredecessor(row, grantDigest) !== undefined,
  ].every(Boolean);

/** The schema-only approval leaves the saved creator selection as-is. */
export const resolveRepositoryProductionPlanRecipient = async (input: {
  approvedSchemaRevision: boolean;
  creatorEmail?: string;
  readRetainedRecipient: () => Promise<string | undefined>;
}): Promise<string | undefined> => {
  if (input.approvedSchemaRevision) {
    if (input.creatorEmail !== undefined) {
      throw new RepositoryProductionCreatorRecipientLockedError();
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined -- No recipient is inferred from the linked account for schema-only setup.
    return undefined;
  }
  return input.creatorEmail ?? (await input.readRetainedRecipient());
};

/** Creator identity and membership remain fresh protected reads for each projection. */
export const readRepositoryProductionCreatorAccess = async (
  row: RepositoryProductionRow | undefined,
  describe: ReturnType<typeof createRepositoryProductionCreator>["describe"],
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Raw protected Auth output is parsed before projecting creator membership.
  readMembers: (row: RepositoryProductionRow) => Promise<unknown>,
) => {
  const checkMembership =
    row?.record.effects["creator-access"].state === "applied" &&
    row.record.creatorActorId !== undefined;
  const [identity, members] = await Promise.allSettled([
    row ? describe(row) : undefined,
    checkMembership ? readMembers(row) : undefined,
  ]);
  // Both protected reads finish before the caller releases its request resources.
  if (identity.status === "rejected") {
    throw identity.reason;
  }
  if (members.status === "rejected") {
    throw members.reason;
  }
  const creatorRemoved = checkMembership
    ? !z
        .array(z.object({ id: z.string() }))
        .parse(members.value)
        .some((person) => person.id === row.record.creatorActorId)
    : false;
  return { identity: identity.value, creatorRemoved };
};

/** Fresh People writes wait only for real in-flight schema or creator-grant effects. */
export const assertNoConflictingProductionSetup = (input: {
  row: RepositoryProductionRow | undefined;
  command?: AppAccessCommand;
  pendingCommandIds: readonly string[];
}) => {
  // Reject before People can journal a command that cannot resume this approved workflow.
  if (hasPendingRepositoryProductionSchemaRevision(input.row)) {
    throw new AppAccessError("app_access_unknown");
  }
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

/** Optional signup observation runs only while this continuation holds the physical app lease. */
export const createRepositoryProductionSignupLeaseGuard = (
  observe: (
    scope: RepositoryProductionScope,
    intent: RepositoryProductionIntent | undefined,
    assertFence: () => Promise<void>,
  ) => Promise<void>,
) => {
  let heldFence: (() => Promise<void>) | undefined;
  return {
    assertNoPending: async (
      scope: RepositoryProductionScope,
      intent?: RepositoryProductionIntent,
    ) => {
      if (heldFence !== undefined) {
        await observe(scope, intent, heldFence);
      }
    },
    run: async <T>(
      assertFence: () => Promise<void>,
      run: (fence: () => Promise<void>) => Promise<T>,
    ) => {
      const previous = heldFence;
      heldFence = assertFence;
      try {
        return await run(assertFence);
      } finally {
        heldFence = previous;
      }
    },
  };
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
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
      const readSession = (owner: RepositoryProductionRequestOwner) =>
        readCanonicalAppOwnerSession(ownerDeps, {
          authority: owner.ownerContext.authority,
          ownerContext: owner.ownerContext,
          target: { appId: owner.appId, sessionId: owner.sessionId },
        });
      const readObservationSession = async (owner: RepositoryProductionRequestOwner) =>
        await readRepositoryProductionObservationSession(owner, {
          readCanonical: readSession,
          readCurrent: async (requested, logicalSessionId) =>
            await defined(sessions.readCurrentBuildSession).call(sessions, {
              authoritySessionId: requested.sessionId,
              logicalSessionId,
              principal: requested.ownerContext.principal,
            }),
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
          repositoryDestination:
            session.builderDestination !== undefined &&
            isExistingRepositoryDestination(session.builderDestination)
              ? session.builderDestination
              : undefined,
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
        const existing = await store.read(scope);
        const savedAccess = existing?.record.intent.access;
        const intent: RepositoryProductionIntent = {
          ...resolveRepositoryProductionSignupIntent(spec, description, savedAccess),
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
        if (existing?.record.intent.creatorEmail !== undefined) {
          intent.creatorEmail = existing.record.intent.creatorEmail;
        }
        const result = {
          approvedSchemaRevision: currentRepositoryProductionSchemaGrant(decision) !== undefined,
          assertCurrentOwner,
          capture,
          description,
          intent,
          owner,
          profile,
          scope,
          compiledPublication: selection?.publishedSource,
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
        readCapture: createRepositoryProductionCaptureReader({
          readSelection: async (artifactContext, storage, assertCurrentOwner) =>
            await createPostgresOperatorArtifactSelections({
              assertCurrentOwner,
              database,
            }).readExact?.(artifactContext, { artifactRef: storage.artifactRef }),
          readRelease: async (artifactContext, selection, assertCurrentOwner) =>
            await createOperatorArtifactPublication({
              assertCurrentOwner,
              store: createPostgresOperatorArtifactStore({ assertCurrentOwner, database }),
            }).readGeneratedRelease(artifactContext, selection),
        }),
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
        requireExisting = false,
      ) => {
        const saved = await store.read(scope);
        return await createRepositoryProductionLease({
          assertAuthorized,
          databaseUrl: environment.PROTECTED_RESOURCE_LOCK_DATABASE_URL ?? settings.databaseUrl,
          intent: requestedIntent ?? saved?.record.intent ?? (await current(scope)).intent,
          store,
          tryAcquire,
          requireExisting,
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
      const readGeneratedRelease = async (row: RepositoryProductionRow) => {
        if (row.record.intent.storage.kind !== "postgres") {
          throw new Error("repository_production_capture_unavailable");
        }
        const { scope, intent } = row.record;
        const known = await current(scope);
        const artifactContext = {
          authority: scope.authority,
          target: { appId: scope.appId, sessionId: intent.sessionId },
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
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
          readCreator: (row) => creator.readCreator(row),
          readGeneratedRelease,
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
            // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
            apply: () =>
              Promise.reject(new Error("repository_production_managed_identity_required")),
            // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
      const verifyCompiledSchemaTransition = async (
        prior: RepositoryProductionRow,
        candidate: RepositoryProductionIntent,
        change: NonNullable<
          NonNullable<DirectProductionGrant["subject"]["revision"]>["schemaChange"]
        >,
      ) => {
        const { scope, intent } = prior.record;
        const saved = intent.storage;
        if (saved.kind !== "postgres" || candidate.storage.kind !== "postgres") {
          throw schemaRevisionUnverified();
        }
        const [oldFiles, newFiles] = await Promise.all([
          readGeneratedRelease(prior),
          readGeneratedRelease({ ...prior, record: { ...prior.record, intent: candidate } }),
        ]);
        assertOptionalTextProductionTransition({
          appId: scope.appId,
          prior: { ...saved, files: oldFiles },
          candidate: { ...candidate.storage, files: newFiles },
          priorCueSha256: change.priorCueSha256,
          candidateCueSha256: change.candidateCueSha256,
        });
      };
      const verifyInstalledSchemaPredecessor = async (prior: RepositoryProductionEffectContext) => {
        await prior.assertCurrent();
        // This worker only reads back the exact installed release and retained connection.
        const observed = await workers(prior.row.record.scope).reconcile(prior);
        if (observed.state !== "applied") {
          throw schemaRevisionUnverified();
        }
        await prior.assertCurrent();
      };
      const setup = (
        scope: RepositoryProductionScope,
        held?: () => Promise<void>,
        assertDirectApproval?: () => Promise<void>,
        schemaRevision?: RepositoryProductionSetupPorts["schemaRevision"],
      ) => {
        const signupGuard = createRepositoryProductionSignupLeaseGuard(
          async (target, intent, assertFence) => {
            await signup.assertNoPending(target, intent, undefined, assertFence);
          },
        );
        return createRepositoryProductionIntentBoundSetup(
          {
            store,
            assertAuthorized: async (target, intent) => {
              await assertAuthorized(target, intent);
              await signupGuard.assertNoPending(target, intent);
            },
            ...workers(scope),
            schemaRevision,
            // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
            prepareCreatorIdentity: (context) => creator.prepare(context),
            reconcileAppAccessUpgrade: createRepositoryProductionAccessUpgrader({
              execute: async (context, command) => {
                // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
                // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
          async (target, intent, run) => {
            const underLease = async (assertFence: () => Promise<void>) => {
              const assertCurrent =
                assertDirectApproval === undefined
                  ? assertFence
                  : async () => {
                      await assertFence();
                      await assertDirectApproval();
                    };
              return await signupGuard.run(assertCurrent, run);
            };
            return held
              ? await underLease(held)
              : await withLease(target, underLease, intent, false, schemaRevision !== undefined);
          },
        );
      };
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
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
        readInvitation: (row, id) =>
          authRequest(readContext(row), { action: "read", invitationId: id }, true),
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
        invokeAuth: (context, operation) => authRequest(context, operation, false),
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
      const readCompletedStatus = createRepositoryProductionCompletionStatus({
        readInvitee: accessJournal.findInvitation,
        readCreator: async (id) => await creator.readCompleted(id),
        readPending: accessJournal.pending,
        assertAuthorized: async ({ owner, scope }) => {
          request.signal.throwIfAborted();
          configured(scope);
          const row = await readRepositoryProductionManagementRecord(
            {
              readSession: async (currentOwner) => {
                await readSession(currentOwner);
              },
              store,
            },
            owner,
            scope,
          );
          // Status has no mutating command to resume; pending IDs cannot exempt it.
          const state = { row, pendingCommandIds: [] };
          assertNoConflictingProductionSetup(state);
          assertNoConflictingCreatorRoleUpdate(state);
          request.signal.throwIfAborted();
        },
      });
      const signup = createRepositoryProductionSignupNative({
        database,
        builderOrigin,
        readSetup: store.read,
        withLease,
        workers,
        realm,
        assertAuthorized,
        hasPendingAccess: async (scope) => {
          const pending = await accessJournal.pending(scope);
          return pending.length > 0;
        },
      });
      const managementFor = (
        held?: () => Promise<void>,
        command?: AppAccessCommand,
        roleUpdate = false,
        automaticCompletion = false,
      ) => {
        const signupGuard = createRepositoryProductionSignupLeaseGuard(
          async (scope, intent, assertFence) => {
            await signup.assertNoPending(
              scope,
              intent,
              command?.action === "remove" ? { cancelActorId: command.memberId } : undefined,
              assertFence,
            );
          },
        );
        return createRepositoryProductionManagement({
          builderOrigin,
          journal: accessJournal,
          cancelPendingSignup: async (input) => await signup.cancel(input),
          withLease: async (scope, run) => {
            const underLease = async (assertFence: () => Promise<void>) =>
              await signupGuard.run(assertFence, run);
            return held
              ? await underLease(held)
              : await withLease(scope, underLease, undefined, automaticCompletion);
          },
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
            const { identity, creatorRemoved } = await readRepositoryProductionCreatorAccess(
              row,
              async (saved) => await creator.describe(saved),
              async (saved) =>
                await authRequest(readContext(saved), { action: listMembersAction }, true),
            );
            const resolved: ManagedAppAccess = {
              scope: known.scope,
              appName: known.scope.appId,
              organizationName: known.profile.organization.name,
              roles: (row?.record.intent.creatorRoles ?? known.intent.creatorRoles).map((id) => ({
                id,
                label: id,
              })),
              canManage: true,
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
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
              await signupGuard.assertNoPending(scope);
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
            // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
                // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
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
      };
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
      const readNativeStatus = createRepositoryProductionNativeStatus({
        resolve: createRepositoryProductionObservationResolver({
          repositories: configuration.repositories,
          readSession: readObservationSession,
          store,
          canObserveSavedSetup: async (owner, scope, row) =>
            canReuseCompletedRepositoryProductionSetup({
              owner,
              scope,
              row,
              current: await resolve(owner),
              isRuntimeBindingReady: (saved) => workers(scope).isRuntimeBindingReady(saved),
            }),
        }),
        teamId: configuration.operator.ownerId,
        readCredential,
        signal: request.signal,
      });
      const readDeliveryStatus = createRepositoryProductionDeliveryStatus({
        repositories: configuration.repositories,
        readSession: async (owner) => {
          await readSession(owner);
        },
        readActiveRevision: async (owner) => {
          const session = await readObservationSession(owner);
          return {
            adapterSessionId: session.adapterSessionId,
            adapterGeneration: session.adapterGeneration,
            cancellationRevision: session.cancellationRevision ?? 0,
          };
        },
        resolveCurrent: resolve,
        store,
        isRuntimeBindingReady: (row) => workers(row.record.scope).isRuntimeBindingReady(row),
      });
      const assertReviewedSchemaSource = (
        found: Awaited<ReturnType<typeof resolve>>,
        session: Awaited<ReturnType<typeof readSession>>,
        grant: DirectProductionGrant,
        reviewedHeadSha?: string,
      ) => {
        const { compiledPublication, intent, scope } = found;
        const review = session.privateBuildDecision?.githubDelivery?.current;
        const approvedReconciliation = grant.subject.revision?.reconciliation;
        const matches = [
          session.status !== "cancelled",
          review !== undefined && review !== null,
          review?.appId === scope.appId,
          review?.appSpecDigest === grant.subject.appSpecDigest,
          session.privateBuildDecision?.currentSpec?.proposalDigest ===
            grant.subject.proposalDigest,
          review?.installationId === grant.subject.installationId,
          isDeepStrictEqual(session.privateBuildDecision?.directProduction, grant),
          compiledPublication !== undefined,
          compiledPublication?.gitSha === intent.sourceSha,
          intent.sourceSha === reviewedHeadSha,
          compiledPublication?.reviewDigest ===
            (approvedReconciliation?.reviewDigest ?? review?.reviewDigest),
          approvedReconciliation?.digest === review?.reconciliationDigest,
          approvedReconciliation === undefined ||
            approvedReconciliation.originPublicationDigest === review?.proposalDigest,
        ].every(Boolean);
        if (!matches) {
          throw schemaRevisionUnverified();
        }
        return defined(review ?? undefined);
      };
      const assertSchemaActivation = async (
        owner: RepositoryProductionRequestOwner,
        found: Awaited<ReturnType<typeof resolve>>,
        session: Awaited<ReturnType<typeof readSession>>,
        grant: DirectProductionGrant,
        activation: RepositoryProductionSchemaActivation,
      ) => {
        const review = assertReviewedSchemaSource(
          found,
          session,
          grant,
          activation.reviewedHeadSha,
        );
        const call = session.privateBuildDecision?.githubDelivery?.calls.find(
          (entry) => entry.callId === activation.deliveryCallId,
        );
        const canonicalOwner = {
          ownerKey: tenantKeyFor(owner.ownerContext.principal),
          adapterSessionId: session.adapterSessionId,
          adapterGeneration: session.adapterGeneration,
          cancellationRevision: session.cancellationRevision ?? 0,
        };
        if (
          call === undefined ||
          call.cancelled === true ||
          call.directProductionGrantDigest !== grant.digest ||
          !isDeepStrictEqual(call.owner, canonicalOwner) ||
          !isDeepStrictEqual(call.subject, review)
        ) {
          throw schemaRevisionUnverified();
        }
        const receipt = await createPostgresGitHubPrEffectStore(
          database,
          owner.ownerContext.authority,
        ).read(activation.mergeIntentDigest);
        const { subject } = grant;
        if (receipt?.status !== "succeeded" || receipt.evidence.kind !== "pr-merge") {
          throw schemaRevisionUnverified();
        }
        const { intent } = receipt;
        const matches = [
          receipt.approvedByCallId === call.callId,
          intent.publicationDigest === review.proposalDigest,
          intent.repositoryId === subject.repositoryId,
          `${intent.owner}/${intent.name}` === subject.repositoryFullName,
          intent.baseBranch === subject.baseBranch,
          intent.headSha === activation.reviewedHeadSha,
          receipt.evidence.mergeCommitSha === activation.mergeSha,
        ].every(Boolean);
        if (!matches) {
          throw schemaRevisionUnverified();
        }
        const native = await readNativeStatus(owner, activation.mergeSha, true);
        if (
          native.deployment.requestedRevisionActive !== true ||
          native.appId !== subject.appId ||
          native.destination?.repositoryId !== subject.repositoryId ||
          native.destination.repositoryFullName !== subject.repositoryFullName
        ) {
          throw schemaRevisionUnverified();
        }
        await found.assertCurrentOwner();
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
        readNativeStatus: async (
          owner,
          expectedMergeSha,
          includeActivationProof,
          expectedSchemaGrantDigest,
        ) => {
          const observed = await readNativeStatus(owner, expectedMergeSha, includeActivationProof);
          return await projectRepositoryProductionSchemaNativeStatus(
            observed,
            includeActivationProof,
            async () => {
              const session = await readSession(owner);
              if (
                expectedSchemaGrantDigest !== undefined &&
                !repositoryProductionSchemaNativeStatusGrantMatches(
                  session.privateBuildDecision,
                  expectedSchemaGrantDigest,
                )
              ) {
                return false;
              }
              const grant = currentRepositoryProductionSchemaGrant(session.privateBuildDecision);
              if (grant === undefined) {
                return true;
              }
              const found = await resolve(owner);
              const sameObservedApp =
                observed.appId === found.scope.appId &&
                observed.destination?.repositoryId === found.scope.repositoryId &&
                observed.destination.repositoryFullName === found.scope.repositoryFullName;
              if (expectedSchemaGrantDigest !== undefined && !sameObservedApp) {
                return false;
              }
              const row = await store.read(found.scope);
              await found.assertCurrentOwner();
              if (expectedSchemaGrantDigest !== undefined) {
                const latest = await readSession(owner);
                if (
                  !repositoryProductionSchemaNativeStatusGrantMatches(
                    latest.privateBuildDecision,
                    expectedSchemaGrantDigest,
                  )
                ) {
                  return false;
                }
              }
              return appliedRepositoryProductionSchemaForGrant(row, found, grant.digest);
            },
            expectedSchemaGrantDigest === undefined ? undefined : true,
          );
        },
        readDeliveryStatus: async (owner, target) => {
          const status = await readDeliveryStatus(owner, target);
          const session = await readSession(owner);
          const grant = session.privateBuildDecision?.directProduction;
          const schemaChange = grant?.subject.revision?.schemaChange;
          if (
            !status.applicable ||
            grant === undefined ||
            schemaChange === undefined ||
            target.reviewedHeadSha === undefined
          ) {
            return status;
          }
          const found = await resolve(owner);
          assertReviewedSchemaSource(found, session, grant, target.reviewedHeadSha);
          assertDirectRepositoryProductionApproval({
            plan: repositoryProductionApprovalInput(found.scope, found.intent),
            grant,
            decision: session.privateBuildDecision,
            destination: session.builderDestination,
            logicalSessionId:
              session.nativeRecoveryBinding?.logicalSessionId ?? session.adapterSessionId,
            owner: owner.ownerContext,
            publishedDescription: found.publishedDescription,
          });
          const row = await store.read(found.scope);
          if (
            row === undefined ||
            !repositoryProductionSchemaEffectsMatch(row, found.intent) ||
            !repositoryProductionSetupComplete(row.record) ||
            !workers(found.scope).isRuntimeBindingReady(row)
          ) {
            throw schemaRevisionUnverified();
          }
          if (isDeepStrictEqual(row.record.intent.storage, found.intent.storage)) {
            if (retainedRepositoryProductionSchemaPredecessor(row, grant.digest) === undefined) {
              throw schemaRevisionUnverified();
            }
          } else {
            await verifyCompiledSchemaTransition(row, found.intent, schemaChange);
          }
          await found.assertCurrentOwner();
          return { ...status, schemaTransitionVerified: true as const };
        },
        resolvePlan: async (owner, creatorEmail) => {
          const found = await resolve(owner);
          const selected = await resolveRepositoryProductionPlanRecipient({
            approvedSchemaRevision: found.approvedSchemaRevision,
            creatorEmail,
            readRetainedRecipient: async () => {
              const saved = await store.read(found.scope);
              return saved ? await creator.readRecipient(saved) : undefined;
            },
          });
          await selectCreatorEmail(found, selected);
          return { scope: found.scope, intent: found.intent };
        },
        resolveSetup: async (
          owner,
          approvedByCallId,
          creatorEmail,
          approvalReference,
          activation,
        ) => {
          const found = await resolve(owner);
          const session = await readSession(owner);
          const savedGrant = session.privateBuildDecision?.directProduction;
          const directProduction = savedGrant?.callId === approvedByCallId ? savedGrant : undefined;
          const schemaChange = directProduction?.subject.revision?.schemaChange;
          const schemaRevision = schemaChange !== undefined;
          if (schemaRevision !== (activation !== undefined)) {
            throw schemaRevisionUnverified();
          }
          if (savedGrant?.subject.revision?.schemaChange !== undefined && !schemaRevision) {
            throw schemaRevisionUnverified();
          }
          if (
            directProduction !== undefined &&
            (approvalReference === undefined || creatorEmail !== undefined)
          ) {
            throw new Error("repository_production_approval_required");
          }
          await selectCreatorEmail(found, creatorEmail);
          const currentPlan = repositoryProductionApprovalInput(found.scope, found.intent);
          if (approvalReference !== undefined) {
            assertRepositoryProductionApprovalReference(currentPlan, approvalReference);
          }
          const assertDirectApproval = async () => {
            if (directProduction === undefined) {
              await found.assertCurrentOwner();
              return;
            }
            const currentOwnerSession = await readSession(owner);
            if (currentOwnerSession.status === "cancelled") {
              throw new Error("repository_production_approval_required");
            }
            if (activation !== undefined) {
              assertReviewedSchemaSource(
                found,
                currentOwnerSession,
                directProduction,
                activation.reviewedHeadSha,
              );
            }
            assertDirectRepositoryProductionApproval({
              plan: currentPlan,
              grant: directProduction,
              decision: currentOwnerSession.privateBuildDecision,
              destination: currentOwnerSession.builderDestination,
              logicalSessionId:
                currentOwnerSession.nativeRecoveryBinding?.logicalSessionId ??
                currentOwnerSession.adapterSessionId,
              owner: owner.ownerContext,
              publishedDescription: found.publishedDescription,
            });
          };
          if (directProduction !== undefined) {
            await assertDirectApproval();
          }
          const schemaSetup: RepositoryProductionSetupPorts["schemaRevision"] =
            activation === undefined || directProduction === undefined || schemaChange === undefined
              ? undefined
              : {
                  grantDigest: directProduction.digest,
                  verify: async (prior, candidate) => {
                    await verifyCompiledSchemaTransition(prior.row, candidate, schemaChange);
                    await verifyInstalledSchemaPredecessor(prior);
                  },
                  assertActive: async () => {
                    await assertSchemaActivation(
                      owner,
                      found,
                      await readSession(owner),
                      directProduction,
                      activation,
                    );
                  },
                };
          await schemaSetup?.assertActive();
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
          const checkpointInput: Parameters<
            typeof createRepositoryProductionApprovalCheckpoint
          >[0] = {
            database,
            plan: currentPlan,
            owner: owner.ownerContext,
            callId: approvedByCallId,
            assertCurrentOwner: assertDirectApproval,
          };
          if (directProduction !== undefined) {
            checkpointInput.directGrantDigest = directProduction.digest;
          }
          const checkpoint = createRepositoryProductionApprovalCheckpoint(checkpointInput);
          const state = await checkpoint.read();
          const observation: NonNullable<
            Parameters<typeof readRepositoryProductionApproval>[0]["observation"]
          > = { save: checkpoint.save };
          if (state !== undefined) {
            observation.state = state;
          }
          const approvalInput: Parameters<typeof readRepositoryProductionApproval>[0] = {
            observation,
            plan: currentPlan,
            callId: approvedByCallId,
            owner: owner.ownerContext,
            assertOwner: assertDirectApproval,
            // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
            readHistory: (startIndex, onEvent) =>
              defined(transport.observePrivateHistory)({
                principal: owner.ownerContext.principal,
                adapterSessionId: owner.ownerContext.adapterSessionId,
                sessionId: owner.sessionId,
                startIndex,
                onEvent,
              }),
          };
          if (directProduction !== undefined) {
            approvalInput.directProduction = {
              grant: directProduction,
              logicalSessionId:
                session.nativeRecoveryBinding?.logicalSessionId ?? session.adapterSessionId,
            };
          }
          const approved = await readRepositoryProductionApproval(approvalInput);
          if (!approved) {
            throw new Error("repository_production_approval_required");
          }
          const approval = {
            ...approved,
            planDigest: repositoryProductionApprovalDigest(found.scope, found.intent),
          };
          await retainRepositoryProductionApproval({
            scope: found.scope,
            intent: found.intent,
            ownerContext: owner.ownerContext,
            approval,
            store,
            requireExisting: schemaRevision,
            assertNoPendingAccess: async (scope, assertFence) => {
              await signup.assertNoPending(scope, undefined, undefined, assertFence);
              const pending = await accessJournal.pending(scope);
              if (pending.length > 0) {
                throw new Error("repository_production_access_reconciliation_required");
              }
            },
            withLease: createRepositoryProductionLease({
              databaseUrl: environment.PROTECTED_RESOURCE_LOCK_DATABASE_URL ?? settings.databaseUrl,
              store,
              intent: found.intent,
              requireExisting: schemaRevision,
              assertAuthorized: async (scope, intent) => {
                const canonical = await resolve(owner);
                if (!schemaRevision) {
                  await selectCreatorEmail(canonical, found.intent.creatorEmail);
                }
                await assertDirectApproval();
                if (
                  !isDeepStrictEqual(canonical.scope, scope) ||
                  repositoryProductionApprovalDigest(scope, canonical.intent) !==
                    approval.planDigest ||
                  repositoryProductionApprovalDigest(scope, intent) !== approval.planDigest ||
                  (directProduction !== undefined &&
                    (!canonical.publishedDescription ||
                      canonical.intent.sourceSha !== currentPlan.intent.sourceSha))
                ) {
                  throw new Error("repository_production_approval_required");
                }
              },
            }),
          });
          return {
            scope: found.scope,
            intent: found.intent,
            setup: setup(
              found.scope,
              undefined,
              directProduction === undefined ? undefined : assertDirectApproval,
              schemaSetup,
            ),
          };
        },
        completeSignup: async (policyId, claimId) => {
          const work = signup.complete(policyId, claimId);
          if (!waitUntil) {
            return await work;
          }
          deferredCleanup = true;
          return await observeRepositoryProductionCompletion(work, waitUntil, dispose);
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
          completeInvitation: async (id) =>
            await completeRepositoryProductionFromStatus(
              async () => await readCompletedStatus(id),
              async () => {
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
            ),
        },
      });
      return await handler(request);
    } finally {
      if (!deferredCleanup) {
        await dispose();
      }
    }
  };
