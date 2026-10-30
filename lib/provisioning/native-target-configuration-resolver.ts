import { z } from "zod";
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
import { createHostedOperatorAppOwnerAuthority } from "./hosted-operator-owner";
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
import { resolveNativeTargetEffectiveConfiguration } from "./native-target-effective-configuration";
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
    sessionId: operatorSelectionSchema.shape.sessionId,
    ownerContext: operatorOwnerContextSchema.optional(),
  }),
  z.object({
    action: z.enum(["plan", "execute", "status", "bindings", "auth-identity-input"]),
    selection: operatorSelectionSchema,
    ownerContext: operatorOwnerContextSchema.optional(),
  }),
  continuityTransportRequestSchema,
  tenantExportTransportRequestSchema,
]);
type ConfigurationRequest = z.infer<typeof configurationRequestSchema>;
interface RegistryInvocation {
  request: Request;
  ownerContext: OperatorOwnerContext;
  sessionId: string;
}
export interface NativeTargetConfigurationResources {
  owner: ReturnType<typeof createHostedOperatorAppOwnerAuthority>;
  registry: Pick<NativeTargetOnboardingStore, "read">;
  continuity: Pick<ContinuityJournalStore, "read">;
  exports: Pick<TenantExportJournalStore, "read">;
  close: () => Promise<void>;
}

const selectedApp = async (
  input: ConfigurationRequest,
  request: Request,
  resources: NativeTargetConfigurationResources,
) => {
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
    input.action === "continuity-status" ||
    input.action === "continuity-read" ||
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

/** The only source of dynamic app configuration is an authorized durable ready registration. */
export const createNativeTargetConfigurationResolver =
  (input: {
    configuration: HostedOperatorSourceConfiguration;
    openResources: () => Promise<NativeTargetConfigurationResources>;
    environment?: Readonly<Record<string, string | undefined>>;
  }) =>
  async (request: Request): Promise<HostedOperatorSourceConfiguration> => {
    let stage: Parameters<typeof reportHostedOperatorNativeFailure>[0] = "resolver_configuration";
    try {
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
        const ownerContext = parsed.data.ownerContext;
        if (ownerContext === undefined || ownerContext.sessionId !== selected.sessionId) {
          throw new HostedOperatorError("authorization_required");
        }
        const reader = createNativeTargetOnboardingReader<RegistryInvocation>({
          store: resources.registry,
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
        });
        stage = "resolver_effective_config";
        return await resolveNativeTargetEffectiveConfiguration({
          configuration: input.configuration,
          invocation: { request, ownerContext, sessionId: selected.sessionId },
          appId: selected.appId,
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
          readReady: async (invocation, appId) => {
            const ready = await reader.readReady(invocation, appId);
            stage = "resolver_effective_config";
            return ready;
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
    const owner = createHostedOperatorAppOwnerAuthority({
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
      workloadPolicy: configuration.workloadPolicy,
      realmContinuation: {
        config: tokenKeyring,
        service: realmContinuationServiceIdentityForWorkload(configuration.workloadPolicy),
      },
    });
    return {
      owner,
      registry: createPostgresNativeTargetOnboardingStore(database),
      continuity: createPostgresContinuityJournalStore(database),
      exports: createPostgresTenantExportJournalStore(database),
      close: async () => {
        await client.end({ timeout: 5 });
      },
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
          dependencies: composeHostedOperatorAuthorizationDependencies(
            readNeonAuthorizationConfiguration(environment),
          ),
          close: () => Promise.resolve(),
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
