import type { ReadExistingPlatformIntegrationReady } from "./app-integration-central-reference";
import { describedBrowserEntryPath } from "../repository/browser-entry-path";
import type {
  PublicReleaseEffectContext,
  PublicReleasePorts,
  PublicReleaseInvocation,
} from "./public-release-handler";
import { and, eq, sql } from "drizzle-orm";
import { builderProvisioningJournals } from "../db/schema";
import { readVerifiedPublicRuntimeBinding } from "./public-runtime-binding";
import { readOptionalIntegrationRetention } from "./public-release-retained-integrations";
import {
  readPublicReleaseIntegrationRemoval,
  requireIntegrationRemovalPorts,
} from "./public-release-integration-removal";
import type { PublicReleaseIntegrationRemovalPorts } from "./public-release-integration-removal";
import { readAppIntegrationCapabilityForRelease } from "./app-integration-release";
import { observeAppIntegrationPublicRelease } from "./app-integration-release-observation";
import type { AppIntegrationReleaseAttachment } from "./app-integration-release-contract";
import type { ReadCentralIntegrationHostReady } from "./app-integration-central-authority";
import { AppIntegrationCapabilityPrerequisiteError } from "./app-integration-capability-prerequisite";
import { readOwnedBuilderRuntime } from "./owned-builder-runtime";
import {
  resolvePublicRealmEnrollment,
  publicRealmLinkConfigurationSchema,
} from "./public-realm-link-configuration";
import {
  assertOwnedAppAuthRuntimeScope,
  ownedAppPublicEnvironmentManifest,
  ownedAppReleaseEnvironmentManifest,
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
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";
import {
  publicReleasePlanSchema,
  publicReleaseOperationRef,
  publicReleasePlanDigest,
} from "./public-release-contract";
import type { PublicReleasePlan } from "./public-release-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan, OperatorOwnerContext } from "./hosted-operator-contract";
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
  createPublicReleaseVercelActiveDeploymentSnapshot,
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

const authBootstrapKind = "auth-bootstrap";
const bindProductionRuntimeEffect = "bind-production-runtime";
const fenceAppIntegrationAuthorityEffect = "fence-app-integration-authority";

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
  readExistingPlatformReady?: ReadExistingPlatformIntegrationReady;
  readCentralReady?: ReadCentralIntegrationHostReady;
  integrationRemoval?: PublicReleaseIntegrationRemovalPorts;
  readSourceOwner?: (
    context: HostedOperatorContext,
    target: { appId: string; sessionId: string },
  ) => Promise<OperatorOwnerContext>;
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
}) => {
  const createPorts: Parameters<typeof createPublicReleaseDispatcher>[0]["createPorts"] = async ({
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
    const load = async () =>
      await readOwnedBuilderRuntime({
        database: input.database,
        readStandardDestination: input.owner.readStandardDestination,
        configuration: input.configuration,
        owner,
        appId,
        assertCurrentOwner,
      });
    const original = await load();
    const { configuration } = input;
    const runtime = standardRuntimeSchema.safeParse(configuration);
    const ownedProfile = configuration?.standardRuntime;
    const { keyring } = input;
    const { environment } = input;
    const { readResourceBindings } = input;
    const { readSourceOwner } = input;
    const { assertRuntimeAuthorized } = input;
    const { databaseUrl } = input;
    if (
      configuration === undefined ||
      ownedProfile === undefined ||
      !runtime.success ||
      keyring === undefined ||
      readResourceBindings === undefined ||
      assertRuntimeAuthorized === undefined ||
      databaseUrl === undefined ||
      environment === undefined
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
    const { productionBranch } = project;
    const { readInstallationScopes } = input;
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
    let heldFence: (() => Promise<void>) | undefined;
    const requestedIntegration =
      transport.action === "public-release-plan"
        ? transport.integrationCapability
        : transport.input.plan.integrationCapability;
    const integrationPrivateScope = (attachment: AppIntegrationReleaseAttachment | undefined) =>
      attachment === undefined
        ? {}
        : {
            integrationCapability: {
              operationRef: attachment.operationRef,
              planDigest: attachment.planDigest,
              capabilitySha256: createHash("sha256")
                .update(JSON.stringify(attachment.capability))
                .digest("hex"),
              configurationSha256: attachment.capability.privateConfiguration.sha256,
            },
          };
    const readSelectedIntegration = async (
      current: PublicReleaseInvocation,
      expected?: AppIntegrationReleaseAttachment,
    ) => {
      if (requestedIntegration === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- No selected optional capability is an explicit read result.
        return undefined;
      }
      if (input.readCentralReady === undefined && input.readExistingPlatformReady === undefined) {
        throw new PublicReleasePrerequisiteError("public_release_integration_capability_required");
      }
      try {
        const prepared = await readAppIntegrationCapabilityForRelease({
          database: input.database,
          keyring,
          pointer: {
            operationRef: requestedIntegration.operationRef,
            planDigest: requestedIntegration.planDigest,
          },
          owner,
          authority: input.owner,
          owned: original,
          publicOrigin,
          builderOrigin: new URL(configuration.builderCallbackOrigin).origin,
          request,
          assertCurrent: async () => {
            await base(current);
            await heldFence?.();
          },
          readCentralReady: input.readCentralReady,
          readExistingPlatformReady: input.readExistingPlatformReady,
          environment,
          fetch: input.fetch,
        });
        if (expected !== undefined && !isDeepStrictEqual(expected, prepared.attachment)) {
          throw fail();
        }
        return prepared;
      } catch (error) {
        if (error instanceof AppIntegrationCapabilityPrerequisiteError) {
          throw new PublicReleasePrerequisiteError(
            "public_release_integration_capability_required",
          );
        }
        throw error;
      }
    };
    const readRetainedIntegrations = async (
      current: PublicReleaseInvocation,
      expected?: PublicReleasePlan,
    ) => {
      const retained = await readOptionalIntegrationRetention({
        database: input.database,
        owner,
        authority: input.owner,
        owned: original,
        ...(original.purpose === "application" ? { allowApplicationRemoval: true as const } : {}),
        publicOrigin,
        request,
        builderOrigin: new URL(configuration.builderCallbackOrigin).origin,
        assertCurrent: async () => {
          await base(current);
          await heldFence?.();
        },
        ...(readSourceOwner === undefined
          ? {}
          : {
              readSourceOwner: async (target: { appId: string; sessionId: string }) =>
                await readSourceOwner(runtimeContext, target),
            }),
        readProviderBindings: async () =>
          await createPublicReleaseVercelBindingSnapshot({
            assertCurrent: async () => {
              await base(current);
              await heldFence?.();
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
            keys: ["APP_INTEGRATIONS_CAPABILITY", "APP_INTEGRATIONS_RUNTIME_CONFIGURATION"],
            signal: current.signal,
          }),
        fetch: input.fetch,
      });
      if (retained === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- No retained binding is distinct from unavailable authority.
        return undefined;
      }
      const removal =
        original.purpose === "application"
          ? await readPublicReleaseIntegrationRemoval({
              ports: input.integrationRemoval,
              invocation: current,
              sourceCapability: retained.sourceCapability,
              ...(expected?.integrationRemoval === undefined
                ? {}
                : {
                    expected: {
                      removal: expected.integrationRemoval,
                      operationRef: publicReleaseOperationRef(expected),
                    },
                  }),
              assertCurrent: async () => {
                await base(current);
                await heldFence?.();
              },
            })
          : undefined;
      return { bindings: retained.bindings, removal };
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
        ...integrationPrivateScope(plan.integrationCapability),
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
      const integrations =
        plan.integrationCapability === undefined
          ? undefined
          : await readSelectedIntegration(current, plan.integrationCapability);
      if (
        integrations !== undefined &&
        values.APP_INTEGRATIONS_RUNTIME_CONFIGURATION !== integrations.serializedConfiguration
      ) {
        throw fail();
      }
      const expected = ownedAppReleaseEnvironmentManifest(
        appId,
        values,
        plan.integrationCapability,
      );
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
      if (plan.integrationCapability !== undefined) {
        await readSelectedIntegration(current, plan.integrationCapability);
      }
      if (
        (plan.purpose === authBootstrapKind || plan.integrationRemoval !== undefined) &&
        !isDeepStrictEqual(
          await readRetainedIntegrations(current, plan),
          plan.retainedOptionalBindings === undefined
            ? undefined
            : { bindings: plan.retainedOptionalBindings, removal: plan.integrationRemoval },
        )
      ) {
        throw new PublicReleasePrerequisiteError("public_release_integration_capability_required");
      }

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
      environment,
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
    const removalContext = (effect: PublicReleaseEffectContext, consent: boolean) => ({
      ...effect,
      assertCurrent: async () => {
        await base(effect.invocation, effect.plan);
        const row = await store.read(effect.invocation.authority, effect.operationRef);
        if (row?.record.planDigest !== publicReleasePlanDigest(effect.plan)) {
          throw fail();
        }
        if (consent) {
          await assertApproved(effect.invocation, effect.plan);
          if (heldFence === undefined) {
            throw fail();
          }
        } else {
          if ((row.record.approvalReceipts?.length ?? 0) === 0) {
            throw fail();
          }
          for (const receipt of row.record.approvalReceipts ?? []) {
            // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Refresh each retained approval in order under the same current physical fence.
            await approval(effect.plan, receipt.approvedByCallId);
          }
        }
        await heldFence?.();
      },
    });
    const github = createPublicReleaseGitHubProvider({
      assertCurrent: (current, plan) => verifyProductionRuntime(current, plan, true),
      readCredential: createPublicReleaseGitHubCredentialReader({
        environment,
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
        if ((plan.purpose ?? "application") === authBootstrapKind) {
          return { releaseId: plan.runtime.releaseId };
        }
        if (plan.integrationCapability !== undefined) {
          const integrations = await readSelectedIntegration(current, plan.integrationCapability);
          if (
            integrations === undefined ||
            !(await observeAppIntegrationPublicRelease({
              publicOrigin: plan.publicOrigin,
              attachment: integrations.attachment,
              setupProofSecret: integrations.setupProofSecret,
              assertCurrent: () => check(current, plan, false),
              signal: current.signal,
              fetch: input.fetch,
            }))
          ) {
            // oxlint-disable-next-line unicorn/no-useless-undefined -- Failed optional runtime readback cannot produce an application readiness observation.
            return undefined;
          }
        }

        const readinessDependencies: Parameters<typeof createHostedOperatorAppReadiness>[0] = {
          assertAuthorized: async () => {
            await check(current, plan, false);
            await assertRuntimeAuthorized(runtimeContext);
          },
          readRuntimeUrl: async () => {
            // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Resolve private credentials only after the active provider snapshot and its final owner check.
            const bindings = await readResourceBindings(runtimeContext);
            return bindings.appDatabase.runtimeUrl;
          },
          readReleaseManifest: () =>
            Promise.resolve(original.captured.files["release-manifest.json"]),
        };
        if (readInstallationScopes !== undefined) {
          readinessDependencies.readInstallationScopes = (readyContext) =>
            readInstallationScopes(readyContext, original.operator.plan);
        }
        const readiness = createHostedOperatorAppReadiness(readinessDependencies);
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
        const activation = await createPublicReleaseVercelActiveDeploymentSnapshot({
          assertCurrent: () => base(current),
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
          repositoryId: refs.repositoryId,
          productionBranch: refs.productionBranch,
          signal: current.signal,
        });
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Resolve private credentials only after the active provider snapshot and its final owner check.
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
          original.purpose === authBootstrapKind ? original.operator : original.record.retainedAuth;
        if (originalSetup === undefined || originalSetup.plan.stage !== authBootstrapKind) {
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
        const integrations = await readSelectedIntegration(current);
        const retention =
          original.purpose === authBootstrapKind ||
          (original.purpose === "application" && original.description.integrations === undefined)
            ? await readRetainedIntegrations(current)
            : undefined;
        const retainedOptionalBindings = retention?.bindings;
        const integrationRemoval = retention?.removal;

        if (
          (original.purpose === "application" &&
            original.description.integrations !== undefined &&
            integrations === undefined) ||
          (original.purpose !== "application" && integrations !== undefined)
        ) {
          throw new PublicReleasePrerequisiteError(
            "public_release_integration_capability_required",
          );
        }
        const prepared = await privateStore.reserve(
          {
            ...scope,
            realmEnrollmentRef: enrollment.enrollmentRef,
            ...integrationPrivateScope(integrations?.attachment),
          },
          () => {
            const values = {
              ...createFreshPublicAuthValues({
                appId,
                publicOrigin,
                authRuntimeUrl: bindings.authDatabase.runtimeUrl,
                productionDatabaseIdentity: runtime.data.standardRuntime.productionDatabaseIdentity,
                authResource,
                seed,
              }),
              [appKey]: bindings.appDatabase.runtimeUrl,
              PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify(enrollment.linkConfiguration),
            };
            ownedAppPublicEnvironmentManifest(appId, values);
            const releaseValues = { ...values, ...integrations?.environment };
            ownedAppReleaseEnvironmentManifest(appId, releaseValues, integrations?.attachment);
            return releaseValues;
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
            priorActiveDeploymentId: activation.priorActiveDeploymentId,
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
          ...(integrations === undefined ? {} : { integrationCapability: integrations.attachment }),
          ...(retainedOptionalBindings === undefined ? {} : { retainedOptionalBindings }),
          environment: prepared.environment,
          ...(integrationRemoval === undefined ? {} : { integrationRemoval }),
          effects:
            integrationRemoval === undefined
              ? [bindProductionRuntimeEffect, "publish-release-source"]
              : [
                  fenceAppIntegrationAuthorityEffect,
                  bindProductionRuntimeEffect,
                  "publish-release-source",
                ],
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
                Object.values(record.effects).some((phase) => phase === "pending"),
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
      reconcileEffect: async (effect) => {
        if (effect.effect === fenceAppIntegrationAuthorityEffect) {
          return await requireIntegrationRemovalPorts(input.integrationRemoval).reconcile(
            removalContext(effect, false),
          );
        }
        if (
          effect.plan.integrationRemoval !== undefined &&
          (await requireIntegrationRemovalPorts(input.integrationRemoval).reconcile({
            ...removalContext(effect, false),
            effect: fenceAppIntegrationAuthorityEffect,
          })) !== "applied"
        ) {
          throw new PublicReleasePrerequisiteError("public_release_integration_removal_required");
        }
        return effect.effect === bindProductionRuntimeEffect
          ? await vercel.reconcileBindings(effect)
          : await github.reconcile(effect);
      },
      applyEffect: async (effect) => {
        if (effect.effect === fenceAppIntegrationAuthorityEffect) {
          await requireIntegrationRemovalPorts(input.integrationRemoval).apply(
            removalContext(effect, true),
          );
          return;
        }
        if (
          effect.plan.integrationRemoval !== undefined &&
          (await requireIntegrationRemovalPorts(input.integrationRemoval).reconcile({
            ...removalContext(effect, false),
            effect: fenceAppIntegrationAuthorityEffect,
          })) !== "applied"
        ) {
          throw new PublicReleasePrerequisiteError("public_release_integration_removal_required");
        }
        await (effect.effect === bindProductionRuntimeEffect
          ? vercel.bindRuntime(effect)
          : github.publish(effect));
      },
      observe: async (current, plan) => {
        await verifyProductionRuntime(current, plan, false);
        return await vercel.observe(current, plan);
      },
    };
  };
  const dispatch = createPublicReleaseDispatcher({ owner: input.owner, createPorts });
  return Object.assign(dispatch, {
    /** Internal read port on the already authenticated operator request; it dispatches no release action. */
    readRuntimeBinding: async (binding: {
      request: Request;
      context: HostedOperatorContext;
      plan: HostedOperatorPlan;
      operationRef: string;
    }) => {
      const { request, context, plan, operationRef } = binding;
      const owner = context.ownerContext;
      if (owner === undefined || plan.runtimePreparation !== "single-project-resources-v1") {
        throw fail();
      }
      const assertCurrentOwner = async () => {
        request.signal.throwIfAborted();
        await input.owner.assertCanonicalAppOwner({
          authority: context.authority,
          ownerContext: owner,
          target: { appId: plan.selection.appId, sessionId: owner.sessionId },
        });
        request.signal.throwIfAborted();
      };
      const current = await readOwnedBuilderRuntime({
        database: input.database,
        readStandardDestination: input.owner.readStandardDestination,
        configuration: input.configuration,
        owner,
        appId: plan.selection.appId,
        assertCurrentOwner,
      });
      if (
        current.operator.operationRef !== operationRef ||
        current.operator.planDigest !== operatorPlanDigest(plan)
      ) {
        throw fail();
      }
      let ports: PublicReleasePorts | undefined;
      let selectedPlan: PublicReleasePlan | undefined;
      const invocation = {
        authority: context.authority,
        sessionId: owner.sessionId,
        callId: "read-public-runtime-bindings",
        signal: request.signal,
      };
      const getPorts = async (selected: PublicReleasePlan) => {
        if (ports === undefined) {
          selectedPlan = selected;
          // This calls the shared read composition directly, never its dispatcher/plan/release effect methods.
          ports = await createPorts({
            request,
            assertCurrentOwner,
            input: {
              action: "public-release-run",
              ownerContext: owner,
              adapterSessionId: owner.adapterSessionId,
              callId: invocation.callId,
              execution: { logicalSessionId: owner.adapterSessionId },
              input: {
                plan: selected,
                operationRef: publicReleaseOperationRef(selected),
                planDigest: publicReleasePlanDigest(selected),
              },
            },
          });
        }
        if (!isDeepStrictEqual(selected, selectedPlan)) {
          throw fail();
        }
        return ports;
      };
      return await readVerifiedPublicRuntimeBinding({
        appEntryPath: describedBrowserEntryPath(current.description.app),
        plan,
        operationRef,
        assertCurrent: assertCurrentOwner,
        readCandidates: async () =>
          await input.database
            .select({
              requestId: builderProvisioningJournals.requestId,
              requestDigest: builderProvisioningJournals.requestDigest,
              record: builderProvisioningJournals.record,
            })
            .from(builderProvisioningJournals)
            .where(
              and(
                eq(builderProvisioningJournals.issuer, context.authority.issuer),
                eq(builderProvisioningJournals.audience, context.authority.audience),
                eq(builderProvisioningJournals.workspaceId, context.authority.workspaceId),
                eq(builderProvisioningJournals.ownerUserId, context.authority.ownerUserId),
                sql`${builderProvisioningJournals.record}->>'kind' = 'public-app-release-v1'`,
                sql`${builderProvisioningJournals.record}->'plan'->>'purpose' = 'application'`,
                sql`${builderProvisioningJournals.record}->'plan'->'selection'->>'appId' = ${plan.selection.appId}`,
                sql`${builderProvisioningJournals.record}->'plan'->'selection'->>'sessionId' = ${owner.sessionId}`,
                sql`${builderProvisioningJournals.record}->'plan'->'runtime'->>'operationRef' = ${operationRef}`,
                sql`${builderProvisioningJournals.record}->'plan'->'runtime'->>'planDigest' = ${operatorPlanDigest(plan)}`,
                sql`${builderProvisioningJournals.record}->'plan'->'project'->>'projectId' = ${plan.selection.projectId}`,
                sql`${builderProvisioningJournals.record}->'plan'->'source'->>'sourceSha' = ${current.selection.publishedSource?.gitSha}`,
                sql`${builderProvisioningJournals.record}->'observation'->>'status' = 'ready'`,
              ),
            )
            .limit(2),
        assertApproved: async (selected, receipt) => {
          const actual = await getPorts(selected);
          await actual.assertAuthorized(invocation, selected);
          await actual.assertApproved(
            { ...invocation, callId: receipt.approvedByCallId },
            selected,
          );
          const reread = await actual.store.read(
            context.authority,
            publicReleaseOperationRef(selected),
          );
          if (
            reread?.record.approvalReceipts?.some((entry) => isDeepStrictEqual(entry, receipt)) !==
            true
          ) {
            throw fail();
          }
        },
        observe: async (selected) => {
          const selectedPorts = await getPorts(selected);
          return await selectedPorts.observe(invocation, selected);
        },
      });
    },
  });
};
