import { appIntegrationCapabilityTransportRequestSchema } from "./app-integration-capability-transport";
import { createBuilderPublicOriginStore } from "./builder-public-origin-store";
import {
  selectStandardBuilderRuntimeProfile,
  assembleStandardBuilderRuntimeConfiguration,
} from "./standard-builder-runtime-configuration";
import { isDeepStrictEqual } from "node:util";
import { readStandardBuilderPublicOrigin } from "./standard-builder-public-origin";
import { createPostgresBuilderProvisionJournalStore } from "./postgres-journal";

import { z } from "zod";
import { publicReleaseTransportRequestSchema } from "./public-release-transport";
import type { StandardBuilderRuntimeCapture } from "./standard-builder-runtime-configuration";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import { createPostgresOperatorArtifactStore } from "./hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";

import { resolveNativeTargetResourceProfile } from "./native-target-resource-profile";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The existing Drizzle stores share the complete database schema.
import * as databaseSchema from "../db/schema";
import { hostedRuntimePostgresOptions } from "../db/postgres-connection-policy";
import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { createPostgresBuilderHandoffStore } from "../handoff/postgres-store";
import { readVercelTokenKeyringEnvironment } from "../integrations/vercel-installation";
import { realmContinuationServiceIdentityForWorkload } from "../hosted/realm-continuation-authority";
import {
  HostedOperatorError,
  operatorSelectionSchema,
  operatorOwnerContextSchema,
} from "./hosted-operator-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import {
  createHostedOperatorAppOwnerAuthority,
  readStandardBuilderDestination,
  readCanonicalAppOwnerSession,
} from "./hosted-operator-owner";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { readHostedOperatorOwnerReaderConfiguration } from "./hosted-operator-owner-context";
import { createPostgresContinuityJournalStore } from "./postgres-hosted-operator-continuity-journal";
import { createPostgresTenantExportJournalStore } from "./postgres-hosted-operator-export-journal";
import type { ContinuityJournalStore } from "./hosted-operator-continuity";
import type { TenantExportJournalStore } from "./hosted-operator-export";
import { continuityTransportRequestSchema } from "./hosted-operator-continuity-transport";
import { tenantExportTransportRequestSchema } from "./hosted-operator-export-transport";
import {
  createNativeTargetOnboardingReader,
  createPostgresNativeTargetOnboardingStore,
} from "./native-target-onboarding-store";
import type { NativeTargetOnboardingStore } from "./native-target-onboarding-store";
import { createPostgresNativeTargetAuthOnlyDispatchStore } from "./native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyDispatchStore } from "./native-target-auth-only-dispatch";
import { resolveNativeTargetEffectiveConfiguration } from "./native-target-effective-configuration";
import { nativeTargetAuthOnlyAuthorityDigest } from "./native-target-auth-only-planner";
import { readHostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import {
  composeHostedOperatorAuthorizationDependencies,
  createRequestScopedHostedOperatorDependencies,
} from "./hosted-operator-composition";
import { readNeonAuthorizationConfiguration } from "./hosted-operator-neon-authorization";
import type { HostedOperatorRequestDependencyLoader } from "./hosted-operator-native";
import { reportHostedOperatorNativeFailure } from "./hosted-operator-native-diagnostic";

// Identity projection only: the existing protected handler validates the complete operation.
// Onboarding/consent actions have their own authority and do not need a configured app yet.
const configurationRequestSchema = z.union([
  z.object({
    action: z.literal("resolve-preview-target"),
    appId: operatorSelectionSchema.shape.appId,
    ownerContext: operatorOwnerContextSchema.optional(),
    sessionId: operatorSelectionSchema.shape.sessionId,
  }),
  z.object({
    action: z.enum(["plan", "execute", "status", "bindings", "auth-identity-input"]),
    ownerContext: operatorOwnerContextSchema.optional(),
    selection: operatorSelectionSchema,
  }),
  appIntegrationCapabilityTransportRequestSchema,
  continuityTransportRequestSchema,
  tenantExportTransportRequestSchema,
  publicReleaseTransportRequestSchema,
  publicReleaseTransportRequestSchema,
]);
type ConfigurationRequest = z.infer<typeof configurationRequestSchema>;
const isPublicReleaseRequest = (input: ConfigurationRequest) =>
  input.action === "public-release-plan" ||
  input.action === "public-release-run" ||
  input.action === "public-release-observe";

interface RegistryInvocation {
  request: Request;
  ownerContext: OperatorOwnerContext;
  sessionId: string;
}
export interface NativeTargetConfigurationResources {
  owner: ReturnType<typeof createHostedOperatorAppOwnerAuthority>;
  registry: Pick<NativeTargetOnboardingStore, "read">;
  authOnlyDispatch?: Pick<NativeTargetAuthOnlyDispatchStore, "read">;
  continuity: Pick<ContinuityJournalStore, "read">;
  exports: Pick<TenantExportJournalStore, "read">;
  readStandardDestination?: (
    input: Parameters<typeof readStandardBuilderDestination>[1],
  ) => ReturnType<typeof readStandardBuilderDestination>;
  readStandardOriginSelection?: (
    context: Parameters<typeof readStandardBuilderDestination>[1],
    destination: NonNullable<Awaited<ReturnType<typeof readStandardBuilderDestination>>>,
  ) => Promise<string | undefined>;
  readStandardPublicOrigin?: (
    context: Parameters<typeof readStandardBuilderDestination>[1],
    destination: NonNullable<Awaited<ReturnType<typeof readStandardBuilderDestination>>>,
  ) => Promise<string>;
  readStandardCapture?: (
    input: Parameters<typeof readStandardBuilderDestination>[1],
  ) => Promise<StandardBuilderRuntimeCapture>;

  close: () => Promise<void>;
}

/** Projects only a verified Auth-only target; it deliberately adds no application database. */
export const resolveNativeTargetAuthOnlyRegistration = async (input: {
  configuration: HostedOperatorSourceConfiguration;
  store: Pick<NativeTargetAuthOnlyDispatchStore, "read">;
  authority: OperatorOwnerContext["authority"];
  sessionId: string;
  appId: string;
  environment: Readonly<Record<string, string | undefined>>;
}) => {
  const policy = input.configuration.authOnlyApplications?.[input.appId];
  if (policy === undefined || input.configuration.applications[input.appId] !== undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const row = await input.store.read({ appId: input.appId, authority: input.authority });
  if (row?.state.stage !== "created") {
    return undefined;
  }
  const { plan, projectId } = row.state;
  if (
    plan.appId !== input.appId ||
    plan.origin.publicSessionId !== input.sessionId ||
    !isDeepStrictEqual(plan.origin.authority, input.authority) ||
    !policy.accessRoles.includes(plan.appRole)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  let selected: HostedOperatorSourceConfiguration;
  try {
    selected = resolveNativeTargetResourceProfile({
      appId: input.appId,
      authority: input.authority,
      base: input.configuration,
      environment: input.environment,
      resourceProfileId: plan.authResource.profileId,
    });
  } catch {
    throw new HostedOperatorError("resource_mismatch");
  }
  const roles = selected.authOnlyApplications?.[input.appId]?.accessRoles;
  if (roles === undefined || !roles.includes(plan.appRole)) {
    throw new HostedOperatorError("resource_mismatch");
  }
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
  const authorityDigest = nativeTargetAuthOnlyAuthorityDigest({
    appId: input.appId,
    authDatabase: selected.authDatabase,
    authority: input.authority,
    authorityBinding: binding,
    physicalEndpointId: selected.nativeNeon.scope.endpointId,
    profileId: plan.authResource.profileId,
    roles,
  });
  if (
    selected.authDatabase.resourceId !== plan.authResource.resourceId ||
    selected.authDatabase.database !== plan.authResource.database ||
    selected.nativeNeon.scope.endpointId !== plan.authResource.endpointId ||
    selected.nativeNeon.scope.hostname !== plan.authResource.hostname ||
    authorityDigest !== plan.authResource.authorityDigest
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  // Return the selected owner/app profile so downstream Auth runtime setup cannot
  // fall back to base/shared Auth custody.
  const effective = structuredClone(selected);
  effective.authOnlyApplications![input.appId]!.registration = {
    appRole: plan.appRole,
    authResource: structuredClone(plan.authResource),
    branch: plan.branch,
    ownerUserId: input.authority.ownerUserId,
    planDigest: row.state.planDigest,
    projectId,
    projectSettings: structuredClone(plan.project.projectSettings),
    sessionId: input.sessionId,
  };
  return effective;
};

const selectedApp = async (
  input: ConfigurationRequest,
  request: Request,
  resources: NativeTargetConfigurationResources,
) => {
  if (
    input.action === "public-release-plan" ||
    input.action === "app-integration-capability-plan"
  ) {
    return { appId: input.appId, sessionId: input.ownerContext.sessionId };
  }
  if (
    input.action === "public-release-run" ||
    input.action === "public-release-observe" ||
    input.action === "app-integration-capability-prepare"
  ) {
    return input.input.plan.selection;
  }
  if (input.action === "resolve-preview-target") {
    return { appId: input.appId, sessionId: input.sessionId };
  }
  if ("selection" in input) {
    return { appId: input.selection.appId, sessionId: input.selection.sessionId };
  }
  // Existing transport semantics: the verified workload may locate an owner-scoped saved
  // operation. Its canonical app/owner is rechecked before any registration is read.
  await resources.owner.verifyWorkload(request);
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- These actions share the same owner-scoped saved intent resolution.
    input.action === "continuity-status" ||
    input.action === "continuity-read" ||
    input.action === "continuity-binding-read" ||
    input.action === "continuity-checkpoints" ||
    input.action === "continuity-verified-actors" ||
    input.action === "continuity-approval" ||
    input.action === "continuity"
  ) {
    const intentId =
      "intentId" in input ? input.intentId : z.uuid().parse(input.planRef.split("/").at(-1));
    const saved = await resources.continuity.read({
      authority: input.ownerContext.authority,
      intentId,
    });
    if (saved === undefined) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return { appId: saved.plan.target.appId, sessionId: saved.plan.target.sessionId };
  }
  const exportId =
    "exportId" in input ? input.exportId : z.uuid().parse(input.planRef.split("/").at(-1));
  const saved = await resources.exports.read({ authority: input.ownerContext.authority, exportId });
  if (saved === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return { appId: saved.originalTarget.appId, sessionId: saved.originalTarget.sessionId };
};

/** Private owner lookup used by authenticated operator requests and canonical callback composition. */
export const resolveOwnedStandardRuntimeConfiguration = async (input: {
  configuration: HostedOperatorSourceConfiguration;
  resources: NativeTargetConfigurationResources;
  context: Parameters<typeof readStandardBuilderDestination>[1];
  environment: Readonly<Record<string, string | undefined>>;
}) => {
  await input.resources.owner.assertCanonicalAppOwner(input.context);
  const destination = await input.resources.readStandardDestination?.(input.context);
  if (destination === undefined) {
    throw new HostedOperatorError("builder_destination_required");
  }
  const captured = await input.resources.readStandardCapture?.(input.context);
  if (captured === undefined) {
    throw new HostedOperatorError("builder_destination_configuration_required");
  }
  const explicitProfile = selectStandardBuilderRuntimeProfile({
    appId: input.context.target.appId,
    authority: input.context.authority,
    environment: input.environment,
  });
  const selectedOrigin = await input.resources.readStandardOriginSelection?.(
    input.context,
    destination,
  );
  if (
    explicitProfile !== undefined &&
    selectedOrigin !== undefined &&
    selectedOrigin !== explicitProfile.publicOrigin
  ) {
    throw new HostedOperatorError("builder_destination_configuration_required");
  }
  const verifiedPublicOrigin =
    input.configuration.standardDevelopmentRuntime === undefined || explicitProfile !== undefined
      ? undefined
      : await input.resources.readStandardPublicOrigin?.(input.context, destination);
  if (
    selectedOrigin !== undefined &&
    verifiedPublicOrigin !== undefined &&
    selectedOrigin !== verifiedPublicOrigin
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const result = assembleStandardBuilderRuntimeConfiguration({
    appId: input.context.target.appId,
    authority: input.context.authority,
    base: input.configuration,
    captured,
    destination,
    environment: input.environment,
    ...(verifiedPublicOrigin === undefined ? {} : { verifiedPublicOrigin }),
  });
  await input.resources.owner.assertCanonicalAppOwner(input.context);
  if (
    (await input.resources.readStandardOriginSelection?.(input.context, destination)) !==
    selectedOrigin
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return result;
};

/** The only source of dynamic app configuration is an authorized durable ready registration. */
export const createNativeTargetConfigurationResolver =
  (input: {
    configuration: HostedOperatorSourceConfiguration;
    openResources: () => Promise<NativeTargetConfigurationResources>;
    environment?: Readonly<Record<string, string | undefined>>;
  }) =>
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Preserve frozen legacy dispatch branches and ordered current-owner checks while adding the generic normal path.
  async (request: Request): Promise<HostedOperatorSourceConfiguration> => {
    let stage: Parameters<typeof reportHostedOperatorNativeFailure>[0] = "resolver_configuration";
    try {
      // Deferred global ingress has no selected app and must not parse an
      // unauthenticated receipt body. Its unavailable handler grants no effects.
      if (new URL(request.url).pathname === "/v1/central-deployment-events") {
        return structuredClone(input.configuration);
      }
      const parsed = configurationRequestSchema.safeParse(await request.json());
      // Consent and independently dispatched actions keep their existing handler authority.
      // Invalid requests remain the protected handler's responsibility, with no private reads here.
      if (!parsed.success) {
        return structuredClone(input.configuration);
      }
      stage = "resolver_resources";
      const resources = await input.openResources();
      try {
        stage = "resolver_owner";
        const selected = await selectedApp(parsed.data, request, resources);
        const { ownerContext } = parsed.data;
        if (ownerContext === undefined || ownerContext.sessionId !== selected.sessionId) {
          throw new HostedOperatorError("authorization_required");
        }
        const authOnlyRuntimeRequest =
          parsed.data.action === "resolve-preview-target" ||
          ("selection" in parsed.data &&
            ["plan", "execute", "status", "bindings", "auth-identity-input"].includes(
              parsed.data.action,
            ));
        if (
          authOnlyRuntimeRequest &&
          input.configuration.authOnlyApplications?.[selected.appId] !== undefined
        ) {
          await resources.owner.verifyWorkload(request);
          const context = {
            authority: ownerContext.authority,
            ownerContext,
            target: { appId: selected.appId, sessionId: selected.sessionId },
          };
          await resources.owner.assertCanonicalAppOwner(context);
          const effective = await resolveNativeTargetAuthOnlyRegistration({
            appId: selected.appId,
            authority: ownerContext.authority,
            configuration: input.configuration,
            environment: input.environment ?? {},
            sessionId: selected.sessionId,
            store: resources.authOnlyDispatch ?? {
              read: async () => {
                throw new HostedOperatorError("resource_mismatch");
              },
            },
          });
          if (effective === undefined) {
            throw new HostedOperatorError("builder_destination_required");
          }
          await resources.owner.assertCanonicalAppOwner(context);
          return effective;
        }
        if (
          input.environment?.PROTECTED_HOSTED_OPERATOR_STANDARD_RUNTIME_PROFILES !== undefined ||
          input.configuration.standardDevelopmentRuntime !== undefined
        ) {
          await resources.owner.verifyWorkload(request);
          const context = {
            authority: ownerContext.authority,
            ownerContext,
            target: { appId: selected.appId, sessionId: selected.sessionId },
          };
          return await resolveOwnedStandardRuntimeConfiguration({
            configuration: input.configuration,
            context,
            environment: input.environment ?? {},
            resources,
          });
        }
        if (input.environment?.PROTECTED_HOSTED_OPERATOR_STANDARD_RUNTIME_PROFILES !== undefined) {
          await resources.owner.verifyWorkload(request);
          const context = {
            authority: ownerContext.authority,
            ownerContext,
            target: { appId: selected.appId, sessionId: selected.sessionId },
          };
          await resources.owner.assertCanonicalAppOwner(context);
          const destination = await resources.readStandardDestination?.(context);
          if (destination === undefined) {
            throw new HostedOperatorError("builder_destination_required");
          }
          const captured = await resources.readStandardCapture?.(context);
          if (captured === undefined) {
            throw new HostedOperatorError("builder_destination_configuration_required");
          }
          const configuration = assembleStandardBuilderRuntimeConfiguration({
            appId: selected.appId,
            authority: ownerContext.authority,
            base: input.configuration,
            captured,
            destination,
            environment: input.environment,
          });
          await resources.owner.assertCanonicalAppOwner(context);
          return configuration;
        }
        if (input.configuration.composition === "single-project-services") {
          await resources.owner.verifyWorkload(request);
          await resources.owner.assertCanonicalAppOwner({
            authority: ownerContext.authority,
            ownerContext,
            target: { appId: selected.appId, sessionId: selected.sessionId },
          });
          const destination = await resources.readStandardDestination?.({
            authority: ownerContext.authority,
            ownerContext,
            target: { appId: selected.appId, sessionId: selected.sessionId },
          });
          if (destination === undefined) {
            throw new HostedOperatorError("builder_destination_required");
          }
          const app = input.configuration.applications[selected.appId];
          if (
            app === undefined ||
            destination.projectId !== app.projectId ||
            destination.projectId !== input.configuration.gateway.projectId ||
            destination.teamId !== input.configuration.teamId
          ) {
            throw new HostedOperatorError("builder_destination_configuration_required");
          }
        }
        // Public delivery cannot borrow a historical dedicated Preview registration.
        if (isPublicReleaseRequest(parsed.data)) {
          if (input.configuration.composition !== "single-project-services") {
            throw new HostedOperatorError("builder_destination_configuration_required");
          }
          return structuredClone(input.configuration);
        }
        if (input.configuration.composition === "single-project-services") {
          await resources.owner.verifyWorkload(request);
          await resources.owner.assertCanonicalAppOwner({
            authority: ownerContext.authority,
            ownerContext,
            target: { appId: selected.appId, sessionId: selected.sessionId },
          });
          const destination = await resources.readStandardDestination?.({
            authority: ownerContext.authority,
            ownerContext,
            target: { appId: selected.appId, sessionId: selected.sessionId },
          });
          if (destination === undefined) {
            throw new HostedOperatorError("builder_destination_required");
          }
          const app = input.configuration.applications[selected.appId];
          if (
            app === undefined ||
            destination.projectId !== app.projectId ||
            destination.projectId !== input.configuration.gateway.projectId ||
            destination.teamId !== input.configuration.teamId
          ) {
            throw new HostedOperatorError("builder_destination_configuration_required");
          }
        }
        // Public delivery cannot borrow a historical dedicated Preview registration.
        if (isPublicReleaseRequest(parsed.data)) {
          if (input.configuration.composition !== "single-project-services") {
            throw new HostedOperatorError("builder_destination_configuration_required");
          }
          return structuredClone(input.configuration);
        }
        const reader = createNativeTargetOnboardingReader<RegistryInvocation>({
          authorize: async (invocation, appId) => {
            stage = "resolver_workload";
            await resources.owner.verifyWorkload(invocation.request);
            stage = "resolver_owner";
            await resources.owner.assertCanonicalAppOwner({
              authority: invocation.ownerContext.authority,
              ownerContext: invocation.ownerContext,
              target: { appId, sessionId: invocation.sessionId },
            });
            stage = "resolver_registry";
            return {
              authority: invocation.ownerContext.authority,
              publicSessionId: invocation.sessionId,
              adapterSessionId: invocation.ownerContext.adapterSessionId,
              adapterGeneration: invocation.ownerContext.adapterGeneration,
            };
          },
          store: resources.registry,
        });
        stage = "resolver_effective_config";
        return await resolveNativeTargetEffectiveConfiguration({
          appId: selected.appId,
          configuration: input.configuration,
          invocation: { ownerContext, request, sessionId: selected.sessionId },
          readReady: async (invocation, appId) => {
            const ready = await reader.readReady(invocation, appId);
            stage = "resolver_effective_config";
            return ready;
          },
          selectResourceConfiguration: (ready) => {
            try {
              return resolveNativeTargetResourceProfile({
                base: input.configuration,
                resourceProfileId: ready.plan.resourceProfileId,
                authority: ownerContext.authority,
                appId: selected.appId,
                environment: input.environment,
              });
            } catch {
              throw new HostedOperatorError("resource_mismatch");
            }
          },
        });
      } finally {
        const previousStage = stage;
        stage = "resolver_dispose";
        await resources.close();
        stage = previousStage;
      }
    } catch (error) {
      reportHostedOperatorNativeFailure(stage, error);
      throw error;
    }
  };

/** Open the existing owner and journal stores without constructing provider mutation adapters. */
export const openNativeTargetConfigurationResources = async (
  configuration: HostedOperatorSourceConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<NativeTargetConfigurationResources> => {
  let settings: ReturnType<typeof readHostedOperatorOwnerReaderConfiguration>;
  try {
    settings = readHostedOperatorOwnerReaderConfiguration(environment);
  } catch (error) {
    reportHostedOperatorNativeFailure("resolver_owner_reader_config", error);
    throw error;
  }
  let tokenKeyring: ReturnType<typeof readVercelTokenKeyringEnvironment>;
  try {
    tokenKeyring = readVercelTokenKeyringEnvironment(environment);
  } catch (error) {
    reportHostedOperatorNativeFailure("resolver_keyring", error);
    throw error;
  }
  const client = postgres(settings.databaseUrl, hostedRuntimePostgresOptions);
  try {
    const database = drizzle(client, { schema: databaseSchema });
    const membership = createPostgresPreviewOrganizationAuthority(database, {
      audience: settings.resource,
      issuer: settings.issuer,
    });
    const ownerDependencies = {
      eve: createPostgresHostedEveStore(database),
      handoffs: createPostgresBuilderHandoffStore(database),
      membership: {
        isMember: async ({ principal, workspaceId }) =>
          await membership.isActiveMember({
            audience: principal.audience,
            issuer: principal.issuer,
            ownerUserId: principal.ownerUserId,
            workspaceId,
          }),
      },
      realmContinuation: {
        config: tokenKeyring,
        service: realmContinuationServiceIdentityForWorkload(configuration.workloadPolicy),
      },
      workloadPolicy: configuration.workloadPolicy,
    } satisfies Parameters<typeof createHostedOperatorAppOwnerAuthority>[0];
    const owner = createHostedOperatorAppOwnerAuthority(ownerDependencies);
    return {
      authOnlyDispatch: createPostgresNativeTargetAuthOnlyDispatchStore(database),
      close: async () => {
        await client.end({ timeout: 5 });
      },
      continuity: createPostgresContinuityJournalStore(database),
      exports: createPostgresTenantExportJournalStore(database),
      owner,
      readStandardCapture: async (context) => {
        const session = await readCanonicalAppOwnerSession(ownerDependencies, context);
        const spec = session.privateBuildDecision?.currentSpec;
        if (spec === undefined || spec.appId !== context.target.appId) {
          throw new HostedOperatorError("builder_destination_configuration_required");
        }
        const artifactContext = { authority: context.authority, target: context.target };
        const assertCurrentOwner = async () => {
          await readCanonicalAppOwnerSession(ownerDependencies, context);
        };
        const selections = createPostgresOperatorArtifactSelections({
          database,
          assertCurrentOwner,
        });
        const selection = await selections.read(artifactContext, spec.appSpecDigest);
        if (selection === undefined || selection.appId !== context.target.appId) {
          throw new HostedOperatorError("builder_destination_configuration_required");
        }
        const publication = createOperatorArtifactPublication({
          store: createPostgresOperatorArtifactStore({ database, assertCurrentOwner }),
          assertCurrentOwner,
        });
        const captured = await publication.readGeneratedRelease(artifactContext, selection);
        await assertCurrentOwner();
        if (captured.description === undefined) {
          throw new HostedOperatorError("builder_destination_configuration_required");
        }
        return { selection, description: captured.description };
      },
      readStandardDestination: async (context) =>
        readStandardBuilderDestination(
          {
            ...ownerDependencies,
            readProvisioning: createPostgresBuilderProvisionJournalStore(database).read,
            findProvisioningForAppRepository:
              createPostgresBuilderProvisionJournalStore(database).findSettledAppRepository,

            readVercelCredential: async (credential) =>
              readActiveVercelInstallationToken({
                ...credential,
                database,
                config: tokenKeyring,
              }),
          },
          context,
        ),
      readStandardOriginSelection: async (context, destination) =>
        createBuilderPublicOriginStore(database).read({
          authority: context.authority,
          scope: {
            appId: context.target.appId,
            projectId: destination.projectId,
            teamId: destination.teamId,
            installationId: destination.installationId,
            provisioningRequestId: destination.provisioningRequestId,
            provisioningDigest: destination.provisioningDigest,
          },
        }),
      readStandardPublicOrigin: async (context, destination) => {
        const destinationDependencies = {
          ...ownerDependencies,
          readProvisioning: createPostgresBuilderProvisionJournalStore(database).read,
          findProvisioningForAppRepository:
            createPostgresBuilderProvisionJournalStore(database).findSettledAppRepository,
          readVercelCredential: async (credential: {
            authority: unknown;
            installationId: string;
          }) =>
            readActiveVercelInstallationToken({ ...credential, database, config: tokenKeyring }),
        };
        const choiceStore = createBuilderPublicOriginStore(database);
        const choiceScope = {
          appId: context.target.appId,
          projectId: destination.projectId,
          teamId: destination.teamId,
          installationId: destination.installationId,
          provisioningRequestId: destination.provisioningRequestId,
          provisioningDigest: destination.provisioningDigest,
        };
        const selectedPublicOrigin = await choiceStore.read({
          authority: context.authority,
          scope: choiceScope,
        });
        return await readStandardBuilderPublicOrigin({
          destination,
          ...(selectedPublicOrigin === undefined ? {} : { selectedPublicOrigin }),
          assertCurrent: async () => {
            if (
              (await choiceStore.read({ authority: context.authority, scope: choiceScope })) !==
              selectedPublicOrigin
            ) {
              throw new HostedOperatorError("resource_mismatch");
            }
            const current = await readStandardBuilderDestination(destinationDependencies, context, {
              requirePublicAppConfiguration: true,
            });
            if (!isDeepStrictEqual(current, destination)) {
              throw new HostedOperatorError("resource_mismatch");
            }
          },
          readCredential: async () =>
            await readActiveVercelInstallationToken({
              authority: context.authority,
              installationId: destination.installationId,
              database,
              config: tokenKeyring,
            }),
        });
      },
      registry: createPostgresNativeTargetOnboardingStore(database),
    };
  } catch (error) {
    try {
      await client.end({ timeout: 5 });
    } catch (disposeError) {
      reportHostedOperatorNativeFailure("resolver_dispose", disposeError);
      throw disposeError;
    }
    throw error;
  }
};

/** Actual native bootstrap: new registrations become available on the next protected operation. */
export const createNativeTargetRequestDependencies =
  (
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): HostedOperatorRequestDependencyLoader =>
  async (request) => {
    if (
      environment.PROTECTED_HOSTED_OPERATOR_CONFIGURATION === undefined ||
      environment.PROTECTED_HOSTED_OPERATOR_CONFIGURATION === ""
    ) {
      try {
        return {
          close: async () => Promise.resolve(),
          dependencies: composeHostedOperatorAuthorizationDependencies(
            readNeonAuthorizationConfiguration(environment),
          ),
        };
      } catch (error) {
        reportHostedOperatorNativeFailure("resolver_configuration_authorization", error);
        throw error;
      }
    }
    let configuration: HostedOperatorSourceConfiguration;
    try {
      configuration = readHostedOperatorSourceConfiguration(environment);
    } catch (error) {
      reportHostedOperatorNativeFailure("resolver_configuration_source", error);
      throw error;
    }
    return await createRequestScopedHostedOperatorDependencies({
      environment,
      resolveConfiguration: createNativeTargetConfigurationResolver({
        configuration,
        environment,
        openResources: async () =>
          await openNativeTargetConfigurationResources(configuration, environment),
      }),
    })(request);
  };
