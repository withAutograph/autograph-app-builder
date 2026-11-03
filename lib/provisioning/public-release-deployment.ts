import { createPostgresBuilderProvisionJournalStore } from "./postgres-journal";
import {
  resolvePublicRealmEnrollment,
  publicRealmLinkConfigurationSchema,
} from "./public-realm-link-configuration";
import {
  assertOwnedAppAuthRuntimeScope,
  ownedAppPublicEnvironmentManifest,
  assertOwnedAppProductionEnvironment,
} from "./owned-app-auth-environment";
import {
  reconcilePublicReleasePlanHistory,
  readPublicReleasePlanHistory,
} from "./public-release-plan-reuse";
/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity, sonarjs/no-nested-functions, sonarjs/expression-complexity -- Native public release composition keeps owner, immutable source, approval and private custody checks together. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createPublicReleaseDispatcher } from "./public-release-dispatcher";
import type { PublicReleaseRequestAuthority } from "./public-release-dispatcher";
import type { HostedOperatorAppOwnerContext } from "./hosted-operator-owner";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import { createPostgresOperatorArtifactStore } from "./hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import { readPublicReleasePreparedRuntime } from "./public-release-readiness";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";
import {
  publicReleasePlanSchema,
  publicReleaseOperationRef,
  publicReleasePlanDigest,
} from "./public-release-contract";
import type { PublicReleasePlan } from "./public-release-contract";
import type { PublicReleasePorts, PublicReleaseInvocation } from "./public-release-handler";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { createPostgresHostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  createPublicReleaseGitHubCredentialReader,
  createPublicReleaseGitHubDestinationReader,
} from "./public-release-github-credential";
import { createPublicReleaseGitHubProvider } from "./public-release-github-provider";
import {
  createPublicReleaseVercelProvider,
  createPublicReleaseVercelBindingSnapshot,
} from "./public-release-vercel-provider";
import { createPublicReleaseAuthObservation } from "./public-release-auth-observation";
import { createPublicReleaseApprovalAuthority } from "./public-release-approval-authority";
import { createPostgresPublicReleaseStore } from "./public-release-store";
import { createPublicReleaseTargetLease } from "./public-release-target-lease";
import {
  createPublicReleaseRuntimeConfigurationStore,
  createFreshPublicAuthValues,
} from "./public-release-runtime-configuration";
import { reservePublicReleaseAuthSeed } from "./public-release-auth-seed";
import type { OperatorAppMetadataScope } from "./hosted-operator-app-readiness";
import { createHostedOperatorAppReadiness } from "./hosted-operator-app-readiness";

const standardRuntimeSchema = z.object({
  standardRuntime: z.object({
    profileId: z.string().min(1),
    productionDatabaseIdentity: z.string().min(1),
    provisioningRequestId: z.uuid(),
    provisioningDigest: z.string(),
    capturedReleaseId: z.string(),
  }),
});
type RuntimeReadContext = HostedOperatorContext & { purpose: "planning"; plan: HostedOperatorPlan };
interface Bindings {
  appDatabase: { runtimeUrl: string };
  authDatabase: { runtimeUrl: string };
}
const fail = () => new Error("public_release_unavailable");

/** Actual native composition; no fixture, alternate project, ambient repository credential or Preview cast. */
export const createPublicReleaseDeployment = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  owner: PublicReleaseRequestAuthority & {
    readStandardDestination: (context: HostedOperatorAppOwnerContext) => Promise<
      | {
          projectId: string;
          teamId: string;
          installationId: string;
          provisioningRequestId: string;
          provisioningDigest: string;
          deploymentAccess?: "public-app";
          repositoryId?: string;
          githubInstallationId?: string;
          productionBranch?: string;
        }
      | undefined
    >;
  };
  configuration?: HostedOperatorSourceConfiguration;
  environment?: Readonly<Record<string, string | undefined>>;
  keyring?: VercelTokenKeyringConfig;
  databaseUrl?: string;
  bindRuntimeWorkload?: (
    context: HostedOperatorContext,
    token: () => string,
    signal: AbortSignal,
  ) => void;
  readResourceBindings?: (context: RuntimeReadContext) => Promise<Bindings>;
  assertRuntimeAuthorized?: (context: RuntimeReadContext) => Promise<void>;
  readInstallationScopes?: (
    context: HostedOperatorContext,
    plan: HostedOperatorPlan,
  ) => Promise<OperatorAppMetadataScope[]>;
  fetch?: typeof fetch;
}) =>
  createPublicReleaseDispatcher({
    owner: input.owner,
    createPorts: async ({
      request,
      input: transport,
      assertCurrentOwner,
    }): Promise<PublicReleasePorts> => {
      const appId =
        transport.action === "public-release-plan"
          ? transport.appId
          : transport.input.plan.selection.appId;
      const owner = transport.ownerContext;
      const context = {
        authority: owner.authority,
        ownerContext: owner,
        target: { appId, sessionId: owner.sessionId },
      };
      const load = async () => {
        const destination = await input.owner.readStandardDestination(context);
        await assertCurrentOwner();
        if (destination === undefined || destination.deploymentAccess !== "public-app") {
          throw new PublicReleasePrerequisiteError("builder_destination_required");
        }
        const provisioning = await createPostgresBuilderProvisionJournalStore(input.database).read({
          authority: owner.authority,
          requestId: destination.provisioningRequestId,
        });
        await assertCurrentOwner();
        if (
          provisioning === undefined ||
          provisioning.state !== "settled" ||
          provisioning.requestDigest !== destination.provisioningDigest ||
          provisioning.record.response.appId !== appId ||
          provisioning.record.response.github.status !== "succeeded" ||
          provisioning.record.response.github.repositoryId !== destination.repositoryId ||
          !provisioning.record.operations.github.attempted ||
          !provisioning.record.operations.github.absentCandidates.includes(
            provisioning.record.response.github.name,
          ) ||
          !provisioning.record.operations.github.candidates.includes(
            provisioning.record.response.github.name,
          )
        ) {
          throw new PublicReleasePrerequisiteError("public_release_source_required");
        }
        const recordedBuilderDestination = {
          appId,
          projectId: destination.projectId,
          repositoryId: provisioning.record.response.github.repositoryId,
          repositoryFullName: provisioning.record.response.github.fullName,
        };
        const marker = input.configuration?.standardRuntime;
        if (marker === undefined) {
          throw new PublicReleasePrerequisiteError("same_project_auth_required");
        }
        const selections = createPostgresOperatorArtifactSelections({
          database: input.database,
          assertCurrentOwner,
        });
        const selection = await selections.read(context, marker.appSpecDigest);
        await assertCurrentOwner();
        if (
          selection === undefined ||
          selection.appId !== appId ||
          selection.appSpecDigest !== marker.appSpecDigest ||
          selection.releaseId !== marker.capturedReleaseId ||
          selection.publishedSource === undefined
        ) {
          throw new PublicReleasePrerequisiteError(
            "public_release_source_required",
            recordedBuilderDestination,
          );
        }
        const prepared = await readPublicReleasePreparedRuntime({
          database: input.database,
          owner,
          target: {
            appId,
            sessionId: owner.sessionId,
            projectId: destination.projectId,
            branch: selection.publishedSource.branch,
            environment: "preview",
            scopeId: destination.teamId,
            scopeType: "team",
            installationId: destination.installationId,
          },
          release: {
            id: selection.releaseId,
            artifactRef: selection.artifactRef,
            sha256: selection.manifestSha256,
          },
          assertCurrentOwner,
        });
        const publication = createOperatorArtifactPublication({
          store: createPostgresOperatorArtifactStore({
            database: input.database,
            assertCurrentOwner,
          }),
          assertCurrentOwner,
        });
        const captured = await publication.readGeneratedRelease(context, selection);
        await assertCurrentOwner();
        if (captured.description?.backend.kind !== "generated-postgres") {
          throw new PublicReleasePrerequisiteError(
            "public_release_source_required",
            recordedBuilderDestination,
          );
        }
        return {
          destination,
          recordedBuilderDestination,
          ...prepared,
          selection,
          captured,
          description: captured.description,
        };
      };
      const original = await load();
      const configuration = input.configuration;
      const runtime = standardRuntimeSchema.safeParse(configuration);
      const ownedProfile = configuration?.standardRuntime;
      const keyring = input.keyring;
      const readResourceBindings = input.readResourceBindings;
      const assertRuntimeAuthorized = input.assertRuntimeAuthorized;
      const databaseUrl = input.databaseUrl;
      if (
        configuration === undefined ||
        ownedProfile === undefined ||
        !runtime.success ||
        keyring === undefined ||
        readResourceBindings === undefined ||
        assertRuntimeAuthorized === undefined ||
        databaseUrl === undefined ||
        input.environment === undefined
      ) {
        throw new PublicReleasePrerequisiteError("same_project_auth_required");
      }
      const source = original.selection.publishedSource;
      const project = original.destination;
      if (
        source === undefined ||
        project.repositoryId !== source.repositoryId ||
        project.githubInstallationId === undefined ||
        project.productionBranch === undefined ||
        configuration.composition !== "single-project-services" ||
        configuration.gateway.projectId !== project.projectId ||
        configuration.gateway.gatewayOrigin !== configuration.gateway.publicOrigin ||
        runtime.data.standardRuntime.provisioningRequestId !== project.provisioningRequestId ||
        runtime.data.standardRuntime.provisioningDigest !== project.provisioningDigest ||
        runtime.data.standardRuntime.capturedReleaseId !== original.selection.releaseId
      ) {
        throw new PublicReleasePrerequisiteError(
          "public_release_source_required",
          original.recordedBuilderDestination,
        );
      }
      const deliveryScope = {
        kind: "builder-created-app-repository" as const,
        provisioningRequestId: project.provisioningRequestId,
        provisioningDigest: project.provisioningDigest,
      };
      const sourceInstallationId = project.githubInstallationId;
      const productionBranch = project.productionBranch;
      const readInstallationScopes = input.readInstallationScopes;
      const publicOrigin = new URL(configuration.gateway.publicOrigin).origin;
      const runtimeContext: RuntimeReadContext = {
        authority: owner.authority,
        ownerContext: owner,
        target: original.record.request,
        purpose: "planning",
        plan: original.operator.plan,
      };
      const bearer = request.headers.get("authorization");
      if (
        bearer === null ||
        !bearer.startsWith("Bearer ") ||
        input.bindRuntimeWorkload === undefined
      ) {
        throw fail();
      }
      input.bindRuntimeWorkload(runtimeContext, () => bearer.slice(7), request.signal);
      const base = async (invocation: PublicReleaseInvocation, plan?: PublicReleasePlan) => {
        invocation.signal.throwIfAborted();
        await assertCurrentOwner();
        const current = await load();
        if (
          !isDeepStrictEqual(current.destination, original.destination) ||
          current.operator.operationRef !== original.operator.operationRef ||
          current.operator.planDigest !== original.operator.planDigest ||
          current.purpose !== original.purpose ||
          !isDeepStrictEqual(current.selection, original.selection)
        ) {
          throw fail();
        }
        await assertRuntimeAuthorized(runtimeContext);
        if (
          plan !== undefined &&
          (plan.selection.appId !== appId ||
            plan.selection.sessionId !== owner.sessionId ||
            !isDeepStrictEqual(plan.authority, owner.authority) ||
            plan.runtime.operationRef !== original.operator.operationRef ||
            plan.runtime.planDigest !== original.operator.planDigest ||
            plan.runtime.releaseId !== original.selection.releaseId ||
            (plan.purpose ?? "application") !== original.purpose ||
            plan.project.projectId !== project.projectId ||
            plan.project.teamId !== project.teamId ||
            plan.project.installationId !== project.installationId ||
            plan.project.provisioningRequestId !== project.provisioningRequestId ||
            plan.project.provisioningDigest !== project.provisioningDigest ||
            plan.publicOrigin !== publicOrigin ||
            !isDeepStrictEqual(plan.source.deliveryScope, deliveryScope) ||
            plan.source.repositoryId !== source.repositoryId ||
            plan.source.installationId !== project.githubInstallationId ||
            plan.source.sourceSha !== source.gitSha ||
            plan.source.sourceBranch !== source.branch ||
            plan.source.reviewDigest !== source.reviewDigest ||
            plan.source.productionBranch !== project.productionBranch)
        ) {
          throw fail();
        }
        invocation.signal.throwIfAborted();
      };
      const scope = {
        authority: owner.authority,
        appId,
        sessionId: owner.sessionId,
        projectId: project.projectId,
        runtimeOperationRef: original.operator.operationRef,
        runtimePlanDigest: original.operator.planDigest,
        releaseId: original.selection.releaseId,
        publicOrigin,
      };
      const privateStore = createPublicReleaseRuntimeConfigurationStore({
        database: input.database,
        keyring,
        target: scope,
        assertCurrentOwner,
      });

      const readValues = async (current: PublicReleaseInvocation, plan: PublicReleasePlan) => {
        await base(current, plan);
        const privateScope = {
          ...scope,
          ...(plan.runtime.realmEnrollmentRef === undefined
            ? {}
            : { realmEnrollmentRef: plan.runtime.realmEnrollmentRef }),
        };
        const values = await privateStore.read(privateScope);
        if (
          values === undefined ||
          plan.runtime.configurationRef !== privateStore.reference(privateScope)
        ) {
          throw fail();
        }
        const link = publicRealmLinkConfigurationSchema.parse(
          JSON.parse(values.PLATFORM_REALM_OPERATOR_LINK_CONFIG),
        );
        if (link.publicEnrollment.enrollmentRef !== plan.runtime.realmEnrollmentRef) {
          throw fail();
        }
        const bindings = await readResourceBindings(runtimeContext);
        assertOwnedAppAuthRuntimeScope({
          appId,
          appResource: original.operator.plan.appDatabase,
          authResource: original.operator.plan.authDatabase,
          neon: original.operator.plan.neon,
          profile: ownedProfile,
          publicOrigin,
          bindings,
        });
        const expected = ownedAppPublicEnvironmentManifest(appId, values);
        if (
          !isDeepStrictEqual(
            expected,
            plan.environment.map(({ key, sha256 }) => ({ key, sha256 })),
          )
        ) {
          throw fail();
        }
        return values;
      };
      const store = createPostgresPublicReleaseStore(input.database);
      const approval = createPublicReleaseApprovalAuthority({
        database: input.database,
        builderOrigin: new URL(configuration.builderCallbackOrigin).origin,
        request,
        owner,
        authority: input.owner,
        assertCurrentOwner,
        fetch: input.fetch,
      });
      const assertApproved: PublicReleasePorts["assertApproved"] = async (current, plan) => {
        await base(current, plan);
        const receipt = await approval(plan, current.callId);
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Read the CAS row after complete native consent so a long history read cannot overwrite newer receipts.
        const row = await store.read(current.authority, publicReleaseOperationRef(plan));
        if (row === undefined) {
          throw fail();
        }
        const existing = row.record.approvalReceipts ?? [];
        const prior = existing.find((entry) => entry.approvedByCallId === receipt.approvedByCallId);
        if (prior !== undefined && !isDeepStrictEqual(prior, receipt)) {
          throw fail();
        }
        if (
          prior === undefined &&
          (await store.compareAndSet(row, {
            ...row.record,
            approvalReceipts: [...existing, receipt],
          })) === undefined
        ) {
          throw fail();
        }
      };
      let heldFence: (() => Promise<void>) | undefined;
      const assertAuthorized: PublicReleasePorts["assertAuthorized"] = async (current, plan) => {
        await base(current, plan);
        await heldFence?.();
      };
      const check = async (
        current: PublicReleaseInvocation,
        plan: PublicReleasePlan,
        consent: boolean,
      ) => {
        await assertAuthorized(current, plan);
        if (consent) {
          await assertApproved(current, plan);
          if (heldFence === undefined) {
            throw fail();
          }
          await heldFence();
        }
      };
      const installations = createPostgresHostedGitHubInstallationStore(input.database);
      const sourceReader = createPublicReleaseGitHubDestinationReader({
        environment: input.environment,
        installations,
        fetch: input.fetch,
        assertCurrentSourceOwner: async (current, selected) => {
          await base(current);
          if (
            selected.repositoryId !== source.repositoryId ||
            selected.installationId !== project.githubInstallationId
          ) {
            throw fail();
          }
        },
      });
      const verifyProductionRuntime = async (
        current: PublicReleaseInvocation,
        plan: PublicReleasePlan,
        consent: boolean,
      ) => {
        await check(current, plan, consent);
        const row = await store.read(current.authority, publicReleaseOperationRef(plan));
        if (row === undefined) {
          throw fail();
        }
        const snapshots = await createPublicReleaseVercelBindingSnapshot({
          assertCurrent: () => check(current, plan, consent),
          assertProjectKeys: (keys) => {
            assertOwnedAppProductionEnvironment(plan, keys);
          },
          readCredential: () =>
            readActiveVercelInstallationToken({
              database: input.database,
              config: keyring,
              authority: current.authority,
              installationId: plan.project.installationId,
            }),
          fetch: input.fetch,
        })({
          projectId: plan.project.projectId,
          teamId: plan.project.teamId,
          installationId: plan.project.installationId,
          keys: plan.environment.map((entry) => entry.key),
          signal: current.signal,
        });
        const byKey = new Map(snapshots.map((observed) => [observed.key, observed]));
        for (const entry of plan.environment) {
          const snapshot = byKey.get(entry.key);
          const binding = row.record.bindings[entry.key];
          if (
            snapshot === undefined ||
            binding?.state !== "applied" ||
            binding.acceptedEnvId !== snapshot.id ||
            snapshot.sha256 !== entry.sha256 ||
            (snapshot.operationRef !== row.operationRef &&
              snapshot.operationRef !== entry.priorBinding?.operationRef)
          ) {
            throw fail();
          }
        }
        await check(current, plan, consent);
      };
      const github = createPublicReleaseGitHubProvider({
        assertCurrent: (current, plan) => verifyProductionRuntime(current, plan, true),
        readCredential: createPublicReleaseGitHubCredentialReader({
          environment: input.environment,
          installations,
          fetch: input.fetch,
          assertCurrent: (current, plan) => verifyProductionRuntime(current, plan, true),
        }),
        fetch: input.fetch,
      });
      const observeAuth = createPublicReleaseAuthObservation({
        assertCurrent: (current, plan) => check(current, plan, false),
        readPrivateValues: readValues,
        fetch: input.fetch,
      });
      const vercel = createPublicReleaseVercelProvider({
        assertCurrent: check,
        readCredential: async (current, plan) => {
          await base(current, plan);
          return await readActiveVercelInstallationToken({
            database: input.database,
            config: keyring,
            authority: current.authority,
            installationId: plan.project.installationId,
          });
        },
        readRuntimeBindings: async (current, plan) =>
          Object.entries(await readValues(current, plan)).map(([key, value]) => ({ key, value })),
        readDeliveredRelease: async (current, plan) => {
          if (!(await observeAuth(current, plan))) {
            // oxlint-disable-next-line unicorn/no-useless-undefined -- Unobserved native Auth leaves the selected deployment pending.
            return undefined;
          }
          if ((plan.purpose ?? "application") === "auth-bootstrap") {
            return { releaseId: plan.runtime.releaseId };
          }
          const readiness = createHostedOperatorAppReadiness({
            assertAuthorized: async () => {
              await check(current, plan, false);
              await assertRuntimeAuthorized(runtimeContext);
            },
            readRuntimeUrl: async () => {
              const bindings = await readResourceBindings(runtimeContext);
              return bindings.appDatabase.runtimeUrl;
            },
            readReleaseManifest: () =>
              Promise.resolve(original.captured.files["release-manifest.json"]),
            ...(readInstallationScopes === undefined
              ? {}
              : {
                  readInstallationScopes: (readyContext) =>
                    readInstallationScopes(readyContext, original.operator.plan),
                }),
          });
          const observed = await readiness({
            ...runtimeContext,
            assertCurrent: () => check(current, plan, false),
          });
          return { releaseId: observed.releaseId };
        },
        fetch: input.fetch,
      });
      return {
        store,
        assertAuthorized,
        assertApproved,
        resolve: async (current) => {
          await base(current);
          const refs = await sourceReader(current, {
            repositoryId: source.repositoryId,
            installationId: sourceInstallationId,
            productionBranch,
            sourceBranch: source.branch,
            deliveryScope,
          });
          if (refs.sourceSha !== source.gitSha) {
            throw new PublicReleasePrerequisiteError(
              "public_release_source_required",
              original.recordedBuilderDestination,
            );
          }
          const bindings = await readResourceBindings(runtimeContext);
          await base(current);
          assertOwnedAppAuthRuntimeScope({
            appId,
            appResource: original.operator.plan.appDatabase,
            authResource: original.operator.plan.authDatabase,
            neon: original.operator.plan.neon,
            profile: ownedProfile,
            publicOrigin,
            bindings,
          });
          const authResource = {
            environment: original.record.request.environment,
            hostname: original.operator.plan.neon.endpoint,
            port: 5432 as const,
            database: original.operator.plan.authDatabase.database,
            schema: "public" as const,
            runtimeRole: original.operator.plan.authDatabase.runtimeRole,
            migratorRole: original.operator.plan.authDatabase.migratorRole,
            neon: {
              projectId: original.operator.plan.neon.projectId,
              branchId: original.operator.plan.neon.branchId,
            },
          };
          const originalSetup =
            original.purpose === "auth-bootstrap"
              ? original.operator
              : original.record.retainedAuth;
          if (originalSetup === undefined || originalSetup.plan.stage !== "auth-bootstrap") {
            throw new PublicReleasePrerequisiteError("public_auth_enrollment_required");
          }
          const enrollment = await resolvePublicRealmEnrollment({
            database: input.database,
            keyring,
            configuration,
            owner: { authority: owner.authority, appId, sessionId: owner.sessionId },
            originalSetup,
            authResource: { version: 1, ...authResource },
            publicOrigin,
            assertCurrentOwner,
          });
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Enrollment and stable secret custody are durably acknowledged in sequence before any runtime configuration is frozen.
          const seed = await reservePublicReleaseAuthSeed({
            database: input.database,
            keyring,
            assertCurrentOwner,
            scope: {
              authority: owner.authority,
              appId,
              sessionId: owner.sessionId,
              projectId: project.projectId,
              publicOrigin,
              authResourceIdentity: createHash("sha256")
                .update(JSON.stringify(authResource))
                .digest("hex"),
            },
          });
          const appKey = `${appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
          if (
            original.description.backend.kind !== "generated-postgres" ||
            original.description.backend.runtime.databaseEnvironment !== appKey
          ) {
            throw fail();
          }
          const prepared = await privateStore.reserve(
            { ...scope, realmEnrollmentRef: enrollment.enrollmentRef },
            () => {
              const values = {
                ...createFreshPublicAuthValues({
                  appId,
                  publicOrigin,
                  authRuntimeUrl: bindings.authDatabase.runtimeUrl,
                  productionDatabaseIdentity:
                    runtime.data.standardRuntime.productionDatabaseIdentity,
                  authResource,
                  seed,
                }),
                [appKey]: bindings.appDatabase.runtimeUrl,
                PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify(enrollment.linkConfiguration),
              };
              ownedAppPublicEnvironmentManifest(appId, values);
              return values;
            },
          );
          await base(current);
          const candidate = publicReleasePlanSchema.parse({
            version: 1,
            kind: "public-app-release-v1",
            purpose: original.purpose,
            authority: owner.authority,
            selection: context.target,
            project: {
              projectId: project.projectId,
              teamId: project.teamId,
              installationId: project.installationId,
              provisioningRequestId: project.provisioningRequestId,
              provisioningDigest: project.provisioningDigest,
              framework: "services",
              rootDirectory: ".",
              deploymentAccess: "public-app",
              environment: "production",
            },
            source: { ...refs, reviewDigest: source.reviewDigest },
            runtime: {
              operationRef: original.operator.operationRef,
              planDigest: original.operator.planDigest,
              releaseId: original.selection.releaseId,
              configurationRef: prepared.configurationRef,
              realmEnrollmentRef: enrollment.enrollmentRef,
              providerEnvironment: "development",
              syntheticOnly: true,
            },
            publicOrigin,
            environment: prepared.environment,
            effects: ["bind-production-runtime", "publish-release-source"],
          });
          const snapshots = await createPublicReleaseVercelBindingSnapshot({
            assertCurrent: () => base(current),
            assertProjectKeys: (keys) => {
              assertOwnedAppProductionEnvironment(candidate, keys);
            },
            readCredential: () =>
              readActiveVercelInstallationToken({
                database: input.database,
                config: keyring,
                authority: owner.authority,
                installationId: project.installationId,
              }),
            fetch: input.fetch,
          })({
            projectId: project.projectId,
            teamId: project.teamId,
            installationId: project.installationId,
            keys: prepared.environment.map((entry) => entry.key),
            signal: current.signal,
          });
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- The canonical journal is reread after the provider snapshot and owner checks, before freezing any prior binding.
          const history = await readPublicReleasePlanHistory({
            database: input.database,
            candidate,
            assertCurrentOwner,
          });
          return reconcilePublicReleasePlanHistory({ candidate, snapshots, records: history });
        },
        withTargetLease: createPublicReleaseTargetLease({
          databaseUrl,
          store,
          assertNoConflictingRelease: async (current, plan) => {
            const history = await readPublicReleasePlanHistory({
              database: input.database,
              candidate: plan,
              assertCurrentOwner: () => base(current, plan),
            });
            if (
              history.some(
                (record) =>
                  record.planDigest !== publicReleasePlanDigest(plan) &&
                  (record.effects["bind-production-runtime"] === "pending" ||
                    record.effects["publish-release-source"] === "pending"),
              )
            ) {
              throw new PublicReleasePrerequisiteError("public_release_reconciliation_required");
            }
          },
          assertCurrent: async (current, plan) => {
            await base(current, plan);
            await assertApproved(current, plan);
          },
          bindFence: (fence) => {
            heldFence = fence;
          },
          lockKeys: (plan) => [
            JSON.stringify([
              "hosted_protected_operator_vercel_project_v1",
              plan.project.teamId,
              plan.project.projectId,
            ]),
            JSON.stringify([
              "public_release_source_v1",
              plan.source.repositoryId,
              plan.source.productionBranch,
            ]),
            ...[original.operator.plan.appDatabase, original.operator.plan.authDatabase].map(
              (resource) =>
                JSON.stringify([
                  "hosted_protected_operator_database_v1",
                  original.operator.plan.neon.projectId,
                  original.operator.plan.neon.branchId,
                  resource.database,
                ]),
            ),
          ],
        }),
        reconcileEffect: (effect) =>
          effect.effect === "bind-production-runtime"
            ? vercel.reconcileBindings(effect)
            : github.reconcile(effect),
        applyEffect: (effect) =>
          effect.effect === "bind-production-runtime"
            ? vercel.bindRuntime(effect)
            : github.publish(effect),
        observe: async (current, plan) => {
          await verifyProductionRuntime(current, plan, false);
          return await vercel.observe(current, plan);
        },
      };
    },
  });
