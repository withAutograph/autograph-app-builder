import { createAppIntegrationProviderDestinationWorker } from "./app-integration-provider-destination";
import { readIntegrationCapabilityEffect,
  appIntegrationCapabilityPlanSchema,
  appIntegrationCapabilityOperationRef } from "./app-integration-capability-contract";
import {
  readAppIntegrationCapabilityProfile,
  selectedAppIntegrationCapabilityProfile,
} from "./app-integration-capability-profile";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";
import { createAppIntegrationCapabilitySandboxWorker } from "./app-integration-capability-sandbox-worker";
/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity, sonarjs/no-nested-functions, sonarjs/expression-complexity -- The protected composition independently binds canonical owner, captured artifact, approvals and private custody before each effect. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import { readOwnedBuilderRuntime } from "./owned-builder-runtime";
import type { ReadOwnedBuilderDestination } from "./owned-builder-runtime";
import { createAppIntegrationCapabilityDispatcher } from "./app-integration-capability-dispatcher";
import type { AppIntegrationCapabilityRequestAuthority } from "./app-integration-capability-dispatcher";
import type {
  ReadCentralIntegrationHostReady,
  CentralIntegrationHostReadyReceipt,
} from "./app-integration-central-authority";
import { AppIntegrationCapabilityPrerequisiteError } from "./app-integration-capability-prerequisite";
import type {
  AppIntegrationCapabilityPlan,
  IntegrationCapabilityReceipt,
} from "./app-integration-capability-contract";
import { createPostgresAppIntegrationCapabilityStore } from "./app-integration-capability-store";
import { createAppIntegrationCapabilityApprovalAuthority } from "./app-integration-capability-approval";
import { createAppIntegrationCapabilityTargetLease } from "./app-integration-capability-target-lease";
import {
  createAppIntegrationPrivateCustody,
  createFreshAppIntegrationPrivateSeed,
  appIntegrationPrivateSeedSchema,
  canonicalIntegrationPrivateJsonBytes,
} from "./app-integration-private-custody";
import { createAppIntegrationPrivateConfiguration } from "./app-integration-private-configuration";
import type {
  IntegrationAuthorityKeyring,
  AppIntegrationAuthorityEnvelope,
} from "./app-integration-private-configuration";
import type {
  AppIntegrationCapabilityEffectContext,
  AppIntegrationCapabilityWorker,
} from "./app-integration-capability-ports";
import type { AppIntegrationCapabilityPorts } from "./app-integration-capability-handler";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = () => new Error("app_integration_capability_unavailable");
export interface AppIntegrationCentralPrivateValues {
  controlMigratorUrl: string;
  productionControlDatabaseIdentity: string;
  authorityKeyring: IntegrationAuthorityKeyring;
  providerApiKey?: string;
}
export type ReadCentralIntegrationHostPrivate = (
  receipt: CentralIntegrationHostReadyReceipt,
  assertCurrent: () => Promise<void>,
) => Promise<AppIntegrationCentralPrivateValues>;
export interface AppIntegrationWorkerPrivateFiles {
  connections: {
    controlMigrator: string;
    controlRuntime: string;
    applicationMigrator: string;
    applicationRuntime: string;
  };
  controlCredentials: { migratorPassword: string; runtimePassword: string };
  authority?: AppIntegrationAuthorityEnvelope;
  controlBootstrap?: { databaseUrl: string; role: string; maintenanceDatabase: string };
}
export type CreateAppIntegrationCapabilityWorker = (input: {
  plan: AppIntegrationCapabilityPlan;
  request: Request;
  configuration: HostedOperatorSourceConfiguration;
  readPrivateFiles: (
    context: AppIntegrationCapabilityEffectContext,
  ) => Promise<AppIntegrationWorkerPrivateFiles>;
}) => AppIntegrationCapabilityWorker;
type RuntimeContext = HostedOperatorContext & { purpose: "planning"; plan: HostedOperatorPlan };
/** Mounted native product path. Missing infrastructure is an actionable prerequisite, never fabricated readiness. */
export const createAppIntegrationCapabilityDeployment = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  owner: AppIntegrationCapabilityRequestAuthority & {
    readStandardDestination: ReadOwnedBuilderDestination;
  };
  configuration?: HostedOperatorSourceConfiguration;
  environment: Readonly<Record<string, string | undefined>>;
  keyring?: VercelTokenKeyringConfig;
  databaseUrl?: string;
  readCentralReady?: ReadCentralIntegrationHostReady;
  readCentralPrivate?: (
    receipt: CentralIntegrationHostReadyReceipt,
    assertCurrent: () => Promise<void>,
  ) => Promise<AppIntegrationCentralPrivateValues>;
  createWorker?: CreateAppIntegrationCapabilityWorker;
  readControlBootstrap?: (
    plan: AppIntegrationCapabilityPlan,
    assertCurrent: () => Promise<void>,
  ) => Promise<{ databaseUrl: string; role: string; maintenanceDatabase: string }>;
  bindRuntimeWorkload?: (
    context: HostedOperatorContext,
    token: () => string,
    signal: AbortSignal,
  ) => void;
  assertRuntimeAuthorized?: (context: RuntimeContext) => Promise<void>;
  readResourceBindings?: (
    context: RuntimeContext,
  ) => Promise<{ appDatabase: { migrationUrl: string; runtimeUrl: string } }>;
  fetch?: typeof fetch;
}) =>
  createAppIntegrationCapabilityDispatcher({
    owner: input.owner,
    createPorts: async ({ request, input: transport, assertCurrentOwner }) => {
      const appId =
        transport.action === "app-integration-capability-plan"
          ? transport.appId
          : transport.input.plan.selection.appId;
      const owner = transport.ownerContext;
      const legacyIntent =
        transport.action !== "app-integration-capability-plan" &&
        transport.input.plan.version === 1;
      const configuration = input.configuration;
      const keyring = input.keyring;
      const readCentralReady = input.readCentralReady;
      const readCentralPrivate = input.readCentralPrivate;
      const createWorker: CreateAppIntegrationCapabilityWorker =
        input.createWorker ??
        (({ configuration: source, readPrivateFiles }) =>
          createAppIntegrationCapabilitySandboxWorker({
            configuration: source.sandbox,
            readPrivateFiles,
          }));
      const readBindings = input.readResourceBindings;
      const assertRuntimeAuthorized = input.assertRuntimeAuthorized;
      const profile = readAppIntegrationCapabilityProfile(input.environment);
      const declared = profile.applications[appId];
      if (declared === undefined) {
        throw new AppIntegrationCapabilityPrerequisiteError("app_integration_profile_required");
      }
      const profileProjection = selectedAppIntegrationCapabilityProfile(profile, appId);
      if (
        configuration === undefined ||
        keyring === undefined ||
        input.databaseUrl === undefined ||
        readBindings === undefined ||
        assertRuntimeAuthorized === undefined ||
        input.bindRuntimeWorkload === undefined
      ) {
        throw new AppIntegrationCapabilityPrerequisiteError(
          "app_integration_application_runtime_required",
        );
      }
      const load = async () => {
        try {
          return await readOwnedBuilderRuntime({
            database: input.database,
            readStandardDestination: input.owner.readStandardDestination,
            configuration,
            owner,
            appId,
            assertCurrentOwner,
          });
        } catch (error) {
          if (error instanceof PublicReleasePrerequisiteError) {
            throw new AppIntegrationCapabilityPrerequisiteError(
              error.code === "public_release_source_required"
                ? "app_integration_source_configuration_required"
                : "app_integration_application_runtime_required",
            );
          }
          throw error;
        }
      };
      const original = await load();
      if (
        original.purpose !== "application" ||
        original.description.backend.kind !== "generated-postgres"
      ) {
        throw new AppIntegrationCapabilityPrerequisiteError(
          "app_integration_application_runtime_required",
        );
      }
      const metadata = original.description.integrations;
      const selected = metadata?.configuration?.find((entry) => entry.provider === "quickbooks");
      if (
        metadata === undefined ||
        selected === undefined ||
        metadata.machineIngress === undefined
      ) {
        throw new AppIntegrationCapabilityPrerequisiteError(
          "app_integration_source_configuration_required",
        );
      }
      if (readCentralReady === undefined || readCentralPrivate === undefined) {
        throw new AppIntegrationCapabilityPrerequisiteError(
          "app_integration_central_host_required",
        );
      }
      if (
        configuration.sandbox.integrationWorker === undefined ||
        (!legacyIntent && configuration.sandbox.integrationResourcesWorker === undefined) ||
        input.readControlBootstrap === undefined
      ) {
        throw new AppIntegrationCapabilityPrerequisiteError("app_integration_worker_required");
      }
      const readReady = async () =>
        await readCentralReady({
          authority: owner.authority,
          appId,
          appProjectId: original.destination.projectId,
          teamId: original.destination.teamId,
          assertCurrentOwner,
          signal: request.signal,
        });
      const central = await readReady();
      if (central === undefined) {
        throw new AppIntegrationCapabilityPrerequisiteError(
          "app_integration_central_host_required",
        );
      }
      if (
        !isDeepStrictEqual(central.authority, owner.authority) ||
        central.caller.projectId !== original.destination.projectId ||
        central.caller.ownerId !== original.destination.teamId ||
        central.caller.environment !== "production" ||
        central.deployment.environment !== "preview"
      ) {
        throw fail();
      }
      const publicOrigin = configuration.gateway.publicOrigin;
      const runtimeEndpointId = original.operator.plan.bootstrap?.endpointId;
      if (runtimeEndpointId === undefined) {
        throw new AppIntegrationCapabilityPrerequisiteError(
          "app_integration_application_runtime_required",
        );
      }
      const runtimeContext: RuntimeContext = {
        authority: owner.authority,
        ownerContext: owner,
        target: original.record.request,
        purpose: "planning",
        plan: original.operator.plan,
      };
      const bearer = request.headers.get("authorization");
      if (bearer === null || !bearer.startsWith("Bearer ")) {
        throw fail();
      }
      input.bindRuntimeWorkload(runtimeContext, () => bearer.slice(7), request.signal);
      const assertBase = async () => {
        request.signal.throwIfAborted();
        await assertCurrentOwner();
        if (
          !isDeepStrictEqual(
            selectedAppIntegrationCapabilityProfile(
              readAppIntegrationCapabilityProfile(input.environment),
              appId,
            ),
            profileProjection,
          )
        ) {
          throw fail();
        }
        const current = await load();
        if (
          !isDeepStrictEqual(current.selection, original.selection) ||
          !isDeepStrictEqual(current.destination, original.destination) ||
          current.operator.operationRef !== original.operator.operationRef ||
          current.operator.planDigest !== original.operator.planDigest
        ) {
          throw fail();
        }
        await assertRuntimeAuthorized(runtimeContext);
        if (!isDeepStrictEqual(await readReady(), central)) {
          throw fail();
        }
      };
      await assertBase();
      if (declared.controlRuntimeRole === central.control.centralRuntimeRole) {
        throw fail();
      }
      if (profile.controlSchema.sha256 !== central.control.schemaSha256) {
        throw new AppIntegrationCapabilityPrerequisiteError("app_integration_profile_required");
      }
      const controlResource = {
        ...central.control.resource,
        runtimeRole: declared.controlRuntimeRole,
      };
      const appScope = {
        authority: owner.authority,
        appId,
        projectId: original.destination.projectId,
        provisioningRequestId: original.destination.provisioningRequestId,
        provisioningDigest: original.destination.provisioningDigest,
        resourceProfileId: central.resourceProfileId,
        controlResource,
        controlNeon: central.control.neon,
      };
      const custody = createAppIntegrationPrivateCustody({
        database: input.database,
        keyring,
        app: appScope,
        assertCurrent: assertBase,
      });
      const seed = await custody.reserve(
        {
          app: appScope,
          purpose: "app-seed",
          version: 1,
          checkpoint: "stable-app-integration-seed-v1",
        },
        createFreshAppIntegrationPrivateSeed,
      );
      const destinationWorker = createAppIntegrationProviderDestinationWorker({
        custody,
        appScope,
        fetch: input.fetch,
        readApiKey: async (assertCurrent) => {
          const values = await readCentralPrivate(central, assertCurrent);
          await assertCurrent();
          if (values.providerApiKey === undefined || values.providerApiKey.length === 0) {
            throw new AppIntegrationCapabilityPrerequisiteError(
              "app_integration_central_host_required",
            );
          }
          return values.providerApiKey;
        },
      });
      let providerDestination:
        | {
            name: string;
            origin: string;
            path: string;
            existing?: { destinationId: string; secretRef: string; secretSha256: string };
          }
        | undefined;
      if (!legacyIntent) {
        const destinations = [
          ...new Set(Object.values(selected.readObjects).map((entry) => entry.destination)),
        ];
        const ingress = metadata.machineIngress.filter(
          (entry) => entry.kind === "quickbooks-ingress",
        );
        const name = destinations[0];
          const path = ingress[0]?.path;
        if (
          destinations.length !== 1 ||
          name === undefined ||
          ingress.length !== 1 ||
          path === undefined
        ) {
          throw new AppIntegrationCapabilityPrerequisiteError(
            "app_integration_source_configuration_required",
          );
        }
        if (transport.action === "app-integration-capability-plan") {
          const existing = await destinationWorker.readOwnedDestination({
            projectId: central.provider.projectId,
            name,
            origin: publicOrigin,
            path,
            signal: request.signal,
            assertCurrent: assertBase,
          });
          providerDestination = {
            name,
            origin: publicOrigin,
            path,
            ...(existing === undefined ? {} : { existing }),
          };
        } else {
          // The owner-scoped canonical journal is checked by the dispatcher before effects.
          // A destination created by this operation must not turn its frozen create intent into reuse on restart.
          const frozen = transport.input.plan.providerDestination;
          if (
            frozen === undefined ||
            frozen.name !== name ||
            frozen.origin !== publicOrigin ||
            frozen.path !== path
          ) {
            throw fail();
          }
          providerDestination = frozen;
        }
      }
      const resource = (value: HostedOperatorPlan["appDatabase"]) => ({
        ...value,
        environment: "preview",
        hostname: original.operator.plan.neon.endpoint,
        port: 5432,
        schema: "public",
      });
      const plan = appIntegrationCapabilityPlanSchema.parse({
        kind: legacyIntent
          ? "app-integrations-capability-plan-v1"
          : "app-integrations-capability-plan-v2",
        version: legacyIntent ? 1 : 2,
        authority: owner.authority,
        selection: { appId, sessionId: owner.sessionId },
        project: {
          projectId: original.destination.projectId,
          teamId: original.destination.teamId,
          installationId: original.destination.installationId,
          provisioningRequestId: original.destination.provisioningRequestId,
          provisioningDigest: original.destination.provisioningDigest,
        },
        release: {
          id: original.selection.releaseId,
          artifactRef: original.selection.artifactRef,
          manifestSha256: original.selection.manifestSha256,
          artifactSha256: original.description.backend.release.artifactHash,
          appSpecDigest: original.selection.appSpecDigest,
        },
        runtime: {
          operationRef: original.operator.operationRef,
          planDigest: original.operator.planDigest,
          appDatabase: resource(original.operator.plan.appDatabase),
          neon: {
            projectId: original.operator.plan.neon.projectId,
            branchId: original.operator.plan.neon.branchId,
            endpointId: runtimeEndpointId,
            source: original.operator.plan.neon.source,
          },
        },
        profileId: profile.id,
        profileDigest: hash(JSON.stringify(profileProjection)),
        publicOrigin,
        workload: configuration.standardRuntime?.publicRealmWorkload,
        readinessPath: metadata.readinessPath,
        control: {
          origin: central.deployment.immutableOrigin,
          resourceProfileId: central.resourceProfileId,
          registrationIdentitySha256: hash(JSON.stringify(appScope)),
          database: controlResource,
          neon: central.control.neon,
          centralHostSetup: {
            operationRef: central.setup.operationRef,
            planDigest: central.setup.planDigest,
            callerOperationRef: central.callerSetup.operationRef,
            callerPlanDigest: central.callerSetup.planDigest,
            projectId: central.deployment.projectId,
            teamId: central.deployment.teamId,
            providerDeploymentId: central.deployment.providerDeploymentId,
            trustedSourcesGrantSha256: central.caller.trustedSourcesGrantSha256,
          },
          schema: profile.controlSchema,
          activationKeyId: central.activation.keyId,
          activationPublicKeySha256: central.activation.publicKeySha256,
        },
        provider: {
          ...central.provider,
          recipeId: selected.recipeId,
          recipeVersion: selected.recipeVersion,
          readObjectsSha256: selected.readObjectsSha256,
        },
        providerConfiguration: { ...selected, artifactRef: original.selection.artifactRef },
        serviceMemberships: declared.serviceMemberships,
        machineIngress: metadata.machineIngress,
        worker: profile.worker,
        ...(legacyIntent
          ? {}
          : {
              resourceWorker: {
                id: configuration.sandbox.integrationResourcesWorker?.id,
                sha256: configuration.sandbox.integrationResourcesWorker?.sha256,
              },
              providerDestination,
            }),
        privateConfigurationSeed: { reference: seed.reference, sha256: seed.sha256 },
        effects: [
          "prepare-control-database",
          "install-control-schema",
          "bind-service-memberships",
          ...(legacyIntent ? [] : ["prepare-provider-destination"]),
          "register-central-app",
        ],
      });
      const store = createPostgresAppIntegrationCapabilityStore(input.database);
      const approval = createAppIntegrationCapabilityApprovalAuthority({
        database: input.database,
        builderOrigin: new URL(configuration.builderCallbackOrigin).origin,
        request,
        owner,
        authority: input.owner,
        assertCurrentOwner: assertBase,
        fetch: input.fetch,
      });
      let heldFence: (() => Promise<void>) | undefined;
      const assertApproved = async (callId: string) => {
        const receipt = await approval(plan, callId);
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Read CAS state only after current native consent has been observed.
        const row = await store.read(owner.authority, appIntegrationCapabilityOperationRef(plan));
        if (row === undefined) {
          throw fail();
        }
        const existing = row.record.approvalReceipts;
        const prior = existing.find((value) => value.approvedByCallId === receipt.approvedByCallId);
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
      const assertAuthorized: AppIntegrationCapabilityPorts["assertAuthorized"] = async (
        invocation,
        current,
        consent,
      ) => {
        await assertBase();
        if (
          !isDeepStrictEqual(current, plan) ||
          !isDeepStrictEqual(invocation.authority, owner.authority) ||
          invocation.sessionId !== owner.sessionId
        ) {
          throw fail();
        }
        if (consent) {
          await assertApproved(invocation.callId);
        }
        await heldFence?.();
      };
      const readCentralValues = async (assertCurrent: () => Promise<void>) => {
        const values = await readCentralPrivate(central, assertCurrent);
        await assertCurrent();
        const url = new URL(values.controlMigratorUrl);
        const production = /^(?<hostname>[a-z0-9.-]+\.neon\.tech)\/[a-z][a-z0-9_]*$/u.exec(
          values.productionControlDatabaseIdentity,
        );
        const normalize = (hostname: string) => hostname.replace(/-pooler(?=\.)/u, "");
        if (
          production === null ||
          normalize(production.groups?.hostname ?? "") === normalize(url.hostname)
        ) {
          throw fail();
        }

        const checks = [
          url.protocol === "postgresql:" || url.protocol === "postgres:",
          url.hostname === controlResource.hostname,
          url.port === "" || url.port === "5432",
          decodeURIComponent(url.pathname.slice(1)) === controlResource.database,
          decodeURIComponent(url.username) === controlResource.migratorRole,
          url.password.length > 0,
          url.searchParams.get("sslmode") === "verify-full",
        ];
        if (checks.includes(false)) {
          throw fail();
        }
        return values;
      };
      const privateConfiguration = async (
        receipts: readonly IntegrationCapabilityReceipt[],
        generation: number,
        assertCurrent: () => Promise<void>,
      ) => {
        const values = await readCentralValues(assertCurrent);
        await assertCurrent();
        return await createAppIntegrationPrivateConfiguration({
          plan,
          custody,
          appScope,
          activationPublicKeyPem: central.activation.publicKeyPem,
          productionControlDatabaseIdentity: values.productionControlDatabaseIdentity,
          authorityKeyring: values.authorityKeyring,
          assertCurrent,
        }).create(receipts, generation);
      };
      const sqlWorker = createWorker({
        plan,
        request,
        configuration,
        readPrivateFiles: async (context) => {
          await context.assertCurrent();
          const values = await readCentralValues(context.assertCurrent);
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Resource custody is reauthorized after central credential custody is read.
          const bindings = await readBindings(runtimeContext);
          await context.assertCurrent();
          const privateSeed = appIntegrationPrivateSeedSchema.parse(seed.value);
          const runtime = new URL(values.controlMigratorUrl);
          runtime.username = controlResource.runtimeRole;
          runtime.password = privateSeed.controlRuntimePassword;
          const row = await store.read(owner.authority, context.operationRef);
          if (row === undefined) {
            throw fail();
          }
          const receipts = plan.effects.flatMap((effect) => {
            const state = readIntegrationCapabilityEffect(row.record, effect);
            return state.state === "applied" ? [state.receipt] : [];
          });
          const preparedPrivate =
            context.effect === "register-central-app"
              ? await privateConfiguration(
                  receipts,
                  context.attemptGeneration,
                  context.assertCurrent,
                )
              : undefined;
          const authority = preparedPrivate?.registration;
          const controlBootstrap =
            context.effect === "prepare-control-database"
              ? await input.readControlBootstrap?.(plan, context.assertCurrent)
              : undefined;
          if (context.effect === "prepare-control-database" && controlBootstrap === undefined) {
            throw new AppIntegrationCapabilityPrerequisiteError("app_integration_worker_required");
          }
          return {
            ...(controlBootstrap === undefined ? {} : { controlBootstrap }),
            connections: {
              controlMigrator: values.controlMigratorUrl,
              controlRuntime: runtime.toString(),
              applicationMigrator: bindings.appDatabase.migrationUrl,
              applicationRuntime: bindings.appDatabase.runtimeUrl,
            },
            controlCredentials: {
              migratorPassword: decodeURIComponent(new URL(values.controlMigratorUrl).password),
              runtimePassword: privateSeed.controlRuntimePassword,
            },
            ...(authority === undefined ? {} : { authority }),
          };
        },
      });
      const worker: AppIntegrationCapabilityWorker = {
        execute: (context) =>
          context.effect === "prepare-provider-destination"
            ? destinationWorker.execute(context)
            : sqlWorker.execute(context),
        reconcile: (context) =>
          context.effect === "prepare-provider-destination"
            ? destinationWorker.reconcile(context)
            : sqlWorker.reconcile(context),
      };
      return {
        store,
        worker,
        resolvePlan: () => Promise.resolve(plan),
        assertAuthorized,
        withTargetLease: createAppIntegrationCapabilityTargetLease({
          databaseUrl: input.databaseUrl,
          store,
          assertCurrent: async (invocation, current, consent) => {
            await assertBase();
            if (!isDeepStrictEqual(current, plan)) {
              throw fail();
            }
            if (consent) {
              await assertApproved(invocation.callId);
            }
          },
          bindFence: (fence) => {
            heldFence = fence;
          },
          lockKeys: (current) => [
            JSON.stringify([
              "hosted_protected_operator_vercel_project_v1",
              current.project.teamId,
              current.project.projectId,
            ]),
            ...[
              { neon: current.runtime.neon, database: current.runtime.appDatabase },
              { neon: current.control.neon, database: current.control.database },
            ].flatMap(({ neon, database }) => [
              JSON.stringify([
                "hosted_protected_operator_database_v1",
                neon.projectId,
                neon.branchId,
                database.database,
              ]),
              ...[database.runtimeRole, database.migratorRole].map((role) =>
                JSON.stringify([
                  "hosted_protected_operator_role_v1",
                  neon.projectId,
                  neon.branchId,
                  role,
                ]),
              ),
            ]),
          ],
        }),
        finalize: async (invocation, current, receipts) => {
          await assertAuthorized(invocation, current, true);
          const registration = receipts.find(
            (receipt) => receipt.effect === "register-central-app",
          );
          if (registration?.effect !== "register-central-app") {
            throw fail();
          }
          const prepared = await privateConfiguration(
            receipts,
            registration.principalGeneration,
            () => assertAuthorized(invocation, current, true),
          );
          if (
            registration.registrationDigest !==
            hash(canonicalIntegrationPrivateJsonBytes(prepared.registration))
          ) {
            throw fail();
          }
          return prepared.capability;
        },
      };
    },
  });
