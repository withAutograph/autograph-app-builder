import { createHash } from "node:crypto";
import postgres from "postgres";
import { getVercelOidcToken } from "@vercel/oidc";
import { createRemoteJWKSet, customFetch } from "jose";
import {
  createRealmIdentityBrowserUrl,
  readVerifiedRealmAccess,
} from "./hosted-operator-auth-identity";
import { createHostedOperatorRealmHttpTransport } from "./hosted-operator-realm-http-transport";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorReceiptSchema,
  restrictedOperatorEnvironment,
} from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  ManagedOperatorEnvironmentRow,
  OperatorDeploymentCandidate,
} from "./hosted-operator-contract";
import type {
  HostedOperatorContext,
  HostedOperatorEffectContext,
  HostedOperatorWorkerEffectContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { openHostedOperatorCompositionResources } from "./hosted-operator-source-configuration";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import { readOwnedOperatorPlanningSelection } from "./hosted-operator-planning-authority";
import {
  createNativePreviewNeonPlanningAuthority,
  createNativePreviewNeonExecutionAuthority,
  createNativePreviewNeonReconciliationAuthority,
} from "./hosted-operator-native-preview-authority";
import { createPreviewNeonMcpReader } from "./hosted-operator-native-preview-neon-mcp";
import { readHostedOperatorProviderInventory } from "./hosted-operator-provider-inventory";
import { createHostedOperatorAuthProposal } from "./hosted-operator-auth-proposal";
import { createHostedOperatorSandboxLauncher } from "./hosted-operator-sandbox-launcher";
import { createHostedOperatorAuthReadiness } from "./hosted-operator-auth-readiness";
import { createHostedOperatorGatewayBindings } from "./hosted-operator-gateway-bindings";
import { createHostedOperatorDeploymentDelivery } from "./hosted-operator-deployment-delivery";
import { createHostedOperatorEnvironmentBindings } from "./hosted-operator-environment-bindings";
import { createHostedOperatorAppReadiness } from "./hosted-operator-app-readiness";

const GATEWAY_DELIVERY = "gateway-delivery";
const GATEWAY_BINDINGS = "gateway-bindings";
const AUTH_SCHEMA_EFFECT = "auth-schema";
const RESOURCE_MISMATCH = "resource_mismatch";
const AUTH_MEMBERSHIP_REQUIRED = "auth_membership_required";
const OPERATION_IN_PROGRESS = "operation_in_progress";
const RECONCILIATION_REQUIRED = "reconciliation_required";
type ControlPlane = Awaited<ReturnType<typeof createHostedOperatorControlPlane>>;
const hash = (
  value: ManagedOperatorEnvironmentRow[] | OperatorDeploymentCandidate | { rows: never[] },
) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const selectedApplication = (
  configuration: HostedOperatorSourceConfiguration,
  context: HostedOperatorContext,
) => {
  const selected = configuration.applications[context.target.appId];
  if (
    selected === undefined ||
    selected.projectId !== context.target.projectId ||
    selected.branch !== context.target.branch ||
    context.target.scopeId !== configuration.teamId
  ) {
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  return selected;
};

const readRelease = async (
  controlPlane: ControlPlane,
  input: HostedOperatorContext & { plan: HostedOperatorPlan },
) => {
  const selection = await controlPlane.readGeneratedSelection(input, input.plan.contextId);
  if (
    selection === undefined ||
    selection.releaseId !== input.plan.release.id ||
    selection.manifestSha256 !== input.plan.release.sha256 ||
    selection.artifactRef !== input.plan.release.artifactRef
  ) {
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  return await controlPlane.readGeneratedRelease(input, selection);
};

const managedContext = (input: HostedOperatorEffectContext) => {
  if (input.checkpointManagedEnvironment === undefined) {
    throw new HostedOperatorError(OPERATION_IN_PROGRESS);
  }
  return { ...input, checkpointManagedEnvironment: input.checkpointManagedEnvironment };
};
const deliveryContext = (input: HostedOperatorEffectContext) => {
  const gateway = input.effect.kind === GATEWAY_DELIVERY;
  const checkpointDelivery = gateway ? input.checkpointGatewayDelivery : input.checkpointDelivery;
  if (checkpointDelivery === undefined) {
    throw new HostedOperatorError(OPERATION_IN_PROGRESS);
  }
  return {
    ...input,
    checkpointDelivery,
    deliveryCandidates: gateway ? input.gatewayDeliveryCandidates : input.deliveryCandidates,
  };
};
const receipt = (input: HostedOperatorEffectContext, resourceVersion: string) =>
  operatorReceiptSchema.parse({
    effectId: input.effect.id,
    fenceGeneration: ["access", "revoke"].includes(input.effect.kind)
      ? input.fenceGeneration
      : undefined,
    observedAt: new Date().toISOString(),
    resourceVersion,
  });
const inspectEmptyAuthNamespace = async (
  url: string,
  input: HostedOperatorEffectContext,
): Promise<boolean> => {
  const parsed = new URL(url);
  if (
    parsed.hostname !== input.plan.neon.endpoint ||
    decodeURIComponent(parsed.username) !== input.plan.authDatabase.runtimeRole ||
    decodeURIComponent(parsed.pathname.slice(1)) !== input.plan.authDatabase.database ||
    parsed.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  await input.assertCurrent();
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {
      /* Database notices remain private. */
    },
    ssl: "verify-full",
  });
  try {
    const rows = await sql.begin(
      "read only",
      async (tx) =>
        await tx<
          { database: string; role: string; empty: boolean }[]
        >`select current_database() as database,current_user as role,not exists(select 1 from pg_namespace where nspname='_auth_schema_readiness') and not exists(select 1 from pg_depend d join pg_namespace n on d.refclassid='pg_namespace'::regclass and d.refobjid=n.oid where n.nspname='public') as empty`,
    );
    await input.assertCurrent();
    return (
      rows.length === 1 &&
      rows[0]?.database === input.plan.authDatabase.database &&
      rows[0]?.role === input.plan.authDatabase.runtimeRole &&
      rows[0]?.empty
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
};
export const resolveFullPlan = async (
  base: HostedOperatorPlan,
  context: HostedOperatorContext,
  configuration: HostedOperatorSourceConfiguration,
  controlPlane: ControlPlane,
  transportIo: Parameters<typeof createHostedOperatorRealmHttpTransport>[2] = {},
): Promise<HostedOperatorPlan> => {
  const captured = await controlPlane.readCapturedRealmIdentity(context);
  if (captured === null) {
    return base;
  }
  const application = selectedApplication(configuration, context);
  const privateProof = await controlPlane.readCapturedRealmIdentityProof(context);
  const transport = createHostedOperatorRealmHttpTransport(
    configuration,
    "operator",
    transportIo,
    captured.endpointOrigin,
  );
  const getKey = createRemoteJWKSet(new URL("/_platform/jwks.json", captured.endpointOrigin), {
    [customFetch]: transport,
  });
  const verified = await readVerifiedRealmAccess({
    assertCurrent: async () => {
      await controlPlane.assertPlanningAuthorized(context);
    },
    getKey,
    pending: privateProof.link,
    proof: privateProof.proof,
    readback: async (request) => await transport(request),
    resource: {
      database: base.authDatabase.database,
      environment: "preview",
      hostname: base.neon.endpoint,
      migratorRole: base.authDatabase.migratorRole,
      neon: { branchId: base.neon.branchId, projectId: base.neon.projectId },
      port: 5432,
      runtimeRole: base.authDatabase.runtimeRole,
      schema: "public",
      version: 1,
    },
  });
  let { organizationId } = verified.identity;
  let authMembership: HostedOperatorPlan["authMembership"];
  if (organizationId === null) {
    const organization = application.organizationProposal;
    if (organization === undefined) {
      throw new HostedOperatorError(AUTH_MEMBERSHIP_REQUIRED);
    }
    ({ organizationId } = organization);
    authMembership = {
      actorId: verified.identity.actorId,
      bootstrapPlanDigest: captured.bootstrapPlanDigest,
      identityCapture: {
        capturedAt: privateProof.link.consumedAt ?? "",
        realmSessionId: verified.identity.sessionId,
      },
      identityNonceSha256: captured.nonceSha256,
      identityProof: {
        reference: privateProof.link.proofRef ?? "",
        sha256: privateProof.link.proofSha256 ?? "",
      },
      identityVerification: {
        audience: captured.audience,
        issuer: captured.issuer,
        jwksUrl: `${captured.endpointOrigin}/_platform/jwks.json`,
        transportSource: configuration.nativeNeon.configuration.operator,
      },
      kind: "create-owned-organization",
      name: organization.name,
      organizationId,
      slug: organization.slug,
    };
  }
  const effects: HostedOperatorPlan["effects"] = [
    ...base.effects.filter((effect) => ![GATEWAY_BINDINGS, GATEWAY_DELIVERY].includes(effect.kind)),
    {
      description:
        "Install and independently observe the exact compiled app release and protected runtime scope.",
      id: "app-install",
      kind: "install",
    },
  ];
  if (authMembership !== undefined) {
    effects.push({
      description:
        "Create the explicitly proposed new organization and owner membership for the normally authenticated existing Realm user.",
      id: "auth-membership",
      kind: "auth-membership",
    });
  }
  effects.push(
    {
      description: "Grant the exact approved current actor and app roles.",
      id: "access",
      kind: "access",
    },
    {
      description: "Bind only app-owned runtime URL and public verification context.",
      id: "bindings",
      kind: "bindings",
    },
    {
      description:
        "Deliver and pin an independently READY native Preview; approved retries may create duplicate owned Preview deployments and usage.",
      id: "delivery",
      kind: "delivery",
    },
  );
  return hostedOperatorPlanSchema.parse({
    ...base,
    access: [
      { actorId: verified.identity.actorId, organizationId, roles: application.accessRoles },
    ],
    authMembership,
    delivery: {
      branch: application.branch,
      gitSha: application.gitSha,
      projectId: application.projectId,
      repoId: application.repoId,
    },
    effects: [
      ...effects,
      ...base.effects.filter((effect) =>
        [GATEWAY_BINDINGS, GATEWAY_DELIVERY].includes(effect.kind),
      ),
    ],
    stage: "app",
  });
};
/** Native source composition uses deployment-owned config and actual private control-plane readers. */
export const composeHostedOperatorDependencies = (
  configuration: HostedOperatorSourceConfiguration,
  controlPlane: ControlPlane,
): ProtectedHostedOperatorDependencies => {
  const launcher = createHostedOperatorSandboxLauncher(configuration.sandbox);
  const proposal = createHostedOperatorAuthProposal(configuration);
  const appEnvironment = createHostedOperatorEnvironmentBindings({
    assertAuthorized: controlPlane.assertAuthorized,
    readCredential: controlPlane.readCredential,
  });
  const privateBindings = async (input: Parameters<ControlPlane["readResourceBindings"]>[0]) =>
    await controlPlane.readResourceBindings(input);
  const authReadiness = createHostedOperatorAuthReadiness({
    assertAuthorized: controlPlane.assertAuthorized,
    readAuthPlan: async (input) => {
      if (input.plan.authSchema === undefined) {
        throw new HostedOperatorError(RESOURCE_MISMATCH);
      }
      const artifact = await controlPlane.readAuthPlan(input, input.plan.authSchema);
      return artifact.content;
    },
    readRuntimeUrl: async (input) => {
      const observed = await privateBindings(input);
      return observed.authDatabase.runtimeUrl;
    },
  });
  const appReadiness = createHostedOperatorAppReadiness({
    assertAuthorized: controlPlane.assertAuthorized,
    readReleaseManifest: async (input) => {
      const release = await readRelease(controlPlane, input);
      return release.files["release-manifest.json"];
    },
    readRuntimeUrl: async (input) => {
      const observed = await privateBindings(input);
      return observed.appDatabase.runtimeUrl;
    },
  });
  const bindings = async (
    input: Parameters<ProtectedHostedOperatorDependencies["bindings"]>[0],
  ) => {
    const urls = await privateBindings(input);
    const boundary = input.plan.deploymentBoundary;
    if (boundary === undefined) {
      throw new HostedOperatorError(RESOURCE_MISMATCH);
    }
    return restrictedOperatorEnvironment(
      input.plan,
      {
        [`${input.target.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`]:
          urls.appDatabase.runtimeUrl,
        PLATFORM_JWKS_URL: boundary.verification.jwksUrl,
        PLATFORM_ORIGIN: boundary.verification.gatewayOrigin,
        PLATFORM_PUBLIC_ORIGIN: boundary.verification.publicOrigin,
      },
      input.authority,
    );
  };

  const gatewayContext = (input: HostedOperatorEffectContext) => {
    if (
      input.checkpointGatewayEnvironment === undefined ||
      input.plan.gatewayBindings === undefined
    ) {
      throw new HostedOperatorError(OPERATION_IN_PROGRESS);
    }
    return {
      ...input,
      checkpointGatewayEnvironment: input.checkpointGatewayEnvironment,
      gateway: {
        ...configuration.gateway,
        builderCallbackOrigin: input.plan.gatewayBindings.builderCallbackOrigin,
        catalogAppIds: input.plan.gatewayBindings.catalogAppIds,
        gatewayOrigin:
          input.plan.deploymentBoundary?.verification.gatewayOrigin ??
          configuration.gateway.gatewayOrigin,
        operatorOrigin: input.plan.gatewayBindings.operatorOrigin,
        readonlyAttesters: input.plan.gatewayBindings.readonlyAttesters,
        sourceWorkload: input.plan.gatewayBindings.sourceWorkload,
      },
    };
  };
  const gatewayEnvironment = createHostedOperatorGatewayBindings({
    assertAuthorized: controlPlane.assertAuthorized,
    readAuthRuntimeUrl: async (input) => {
      const observed = await privateBindings(input);
      return observed.authDatabase.runtimeUrl;
    },
    readCredential: controlPlane.readCredential,
  });
  const appDelivery = createHostedOperatorDeploymentDelivery({
    assertAuthorized: controlPlane.assertAuthorized,
    assertEnvironment: async (input) => {
      await appEnvironment.verifyForDelivery(managedContext(input), await bindings(input));
    },
    readCredential: controlPlane.readCredential,
  });
  const gatewayDelivery = createHostedOperatorDeploymentDelivery({
    assertAuthorized: controlPlane.assertAuthorized,
    assertEnvironment: async (input) => {
      await gatewayEnvironment.verifyForDelivery(gatewayContext(input));
    },
    readCredential: controlPlane.readCredential,
    target: "gateway",
  });

  const plan = async (
    context: HostedOperatorContext & { action: "prepare" | "cleanup" },
  ): Promise<HostedOperatorPlan> => {
    const application = selectedApplication(configuration, context);
    const current = await controlPlane.store.read(context);
    if (context.action === "cleanup") {
      if (current?.record.operator === undefined) {
        throw new HostedOperatorError(OPERATION_IN_PROGRESS);
      }
      const retained = current.record.operator.plan;
      const {
        authMembership: oldMembership,
        delivery: oldDelivery,
        gatewayBindings: oldBindings,
        gatewayDelivery: oldGatewayDelivery,
        ...cleanupBase
      } = retained;
      void oldMembership;
      void oldDelivery;
      void oldBindings;
      void oldGatewayDelivery;
      return hostedOperatorPlanSchema.parse({
        ...cleanupBase,
        action: "cleanup",
        effects: [
          {
            description:
              "Close and independently observe app access before revoking this app in shared Auth.",
            id: "revoke",
            kind: "revoke",
          },
          {
            description: "Remove only journal-owned app Preview environment rows.",
            id: "remove-bindings",
            kind: "remove-bindings",
          },
          {
            description:
              "Retire owned app database and exclusively tagged app roles; retain shared Auth and unrelated roles.",
            id: "retire",
            kind: "retire",
            resourceId: retained.appDatabase.resourceId,
          },
        ],

        stage: "app",
      });
    }
    const selected = await readOwnedOperatorPlanningSelection({ context, controlPlane });
    if (selected.selection === undefined) {
      throw new HostedOperatorError("operator_unavailable");
    }
    await controlPlane.readGeneratedRelease(context, selected.selection);
    const planning = createNativePreviewNeonPlanningAuthority({
      context,
      controlPlane,
      nativeStore: configuration.nativeNeon.configuration.nativeStore,
      scope: configuration.nativeNeon.scope,
    });
    const neon = createPreviewNeonMcpReader({
      ...planning,
      assertApprovedScope: async (...args) => {
        await planning.assertPlanningScope(...args);
      },
      configuration: configuration.nativeNeon.configuration,
    });
    await neon.inspectPlanningTarget(context, configuration.nativeNeon.scope);
    const recordedGateway = current?.record.operator?.gatewayDeliveryCandidates?.find(
      (candidate) =>
        candidate.deploymentId === current.record.operator?.deliveredGatewayDeploymentId &&
        candidate.readyState === "READY",
    );
    const gatewayReference =
      recordedGateway === undefined
        ? configuration.gateway
        : {
            ...configuration.gateway,
            deploymentId: recordedGateway.deploymentId,
            gatewayOrigin: recordedGateway.origin,
          };
    const inventory = await readHostedOperatorProviderInventory({
      phase: "bootstrap-planning",
      assertCurrentOwner: async () => {
        await controlPlane.assertPlanningAuthorized(context);
      },
      configuration: {
        app: { ...application, environment: "preview" },
        gateway: gatewayReference,
        operator: configuration.operator,
        verification: {
          gatewayOrigin: gatewayReference.gatewayOrigin,
          publicOrigin: configuration.gateway.publicOrigin,
        },
      },
      context,
      readVercelCredential: async ({ authority, installationId }) =>
        await controlPlane.readCredential(authority, installationId),
    });
    const native = configuration.nativeNeon.scope;
    let authSchema = current?.record.operator?.plan.authSchema;
    if (authSchema === undefined) {
      const proposed = await proposal({
        assertCurrentOwner: async () => {
          await controlPlane.assertPlanningAuthorized(context);
        },
        resource: {
          database: configuration.authDatabase.database,
          environment: "preview",
          hostname: native.hostname,
          migratorRole: configuration.authDatabase.migratorRole,
          neon: { branchId: native.branchId, projectId: native.projectId },
          port: 5432,
          runtimeRole: configuration.authDatabase.runtimeRole,
          schema: "public",
          version: 1,
        },
      });
      const artifactRef = await controlPlane.publishAuthPlan(context, proposed);
      authSchema = {
        artifactRef,
        installer: {
          reference: configuration.sandbox.authWorker.id,
          sha256: configuration.sandbox.authWorker.sha256,
        },
        planDigest: proposed.planDigest,
        targetDigest: proposed.targetDigest,
      };
    }
    const worker = configuration.sandbox.workers[context.target.appId];
    if (worker === undefined) {
      throw new HostedOperatorError("operator_unavailable");
    }
    const base = hostedOperatorPlanSchema.parse({
      access: [],
      action: "prepare",
      appDatabase: application.appDatabase,
      authDatabase: configuration.authDatabase,
      authSchema,
      bootstrap: {
        endpointId: native.endpointId,
        maintenanceDatabase: native.maintenanceDatabase,
        role: native.maintenanceRole,
      },
      contextId: selected.currentSpec.appSpecDigest,
      cost: {
        class: "shared-recovery-group",
        description:
          "Preview-only resources and Auth bootstrap. Explicit normal Git delivery retries may create duplicate owned Preview deployments and provider usage charges. No human login or app preparation is established by schema readiness.",
        owner: context.authority.ownerUserId,
      },
      deploymentBoundary: {
        app: {
          branch: inventory.app.branch,
          deploymentId: inventory.app.deploymentId,
          environment: inventory.app.environment,
          projectId: inventory.app.projectId,
        },
        authority: context.authority,
        gateway: {
          branch: inventory.gateway.branch,
          deploymentId: inventory.gateway.deploymentId,
          environment: inventory.gateway.environment,
          projectId: inventory.gateway.projectId,
        },
        operator: {
          deploymentId: inventory.operator.deploymentId,
          environment: inventory.operator.environment,
          projectId: inventory.operator.projectId,
        },
        teamId: configuration.teamId,
        verification: {
          gatewayOrigin: inventory.verification.gatewayOrigin,
          jwksUrl: inventory.verification.jwksUrl,
          publicOrigin: inventory.verification.publicOrigin,
        },
      },
      effects: [
        {
          description: "Prepare or observe the exact owned shared Auth database and roles.",
          id: "auth-resources",
          kind: "resources",
          resourceId: configuration.authDatabase.resourceId,
        },
        {
          description: "Prepare or observe the exact owned app database and roles.",
          id: "app-resources",
          kind: "resources",
          resourceId: application.appDatabase.resourceId,
        },
        {
          description: "Independently replan and migrate the approved shared Auth target.",
          id: AUTH_SCHEMA_EFFECT,
          kind: "install",
        },
      ],
      installer: { reference: worker.id, sha256: worker.sha256 },
      neon: {
        branchId: native.branchId,
        connectionRef: configuration.nativeNeon.configuration.connector,
        endpoint: native.hostname,
        projectId: native.projectId,
        source: "synthetic-only",
      },
      publicGateway: {
        branch: inventory.gateway.branch,
        origin: inventory.verification.gatewayOrigin,
        projectId: inventory.gateway.projectId,
      },
      release: {
        artifactRef: selected.selection.artifactRef,
        id: selected.selection.releaseId,
        sha256: selected.selection.manifestSha256,
      },
      resourcesInstaller: {
        reference: configuration.sandbox.resourcesWorker.id,
        sha256: configuration.sandbox.resourcesWorker.sha256,
      },
      retention: {
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        policy:
          "Retain shared Auth; cleanup only owned app resources under a new concrete approval.",
      },
      selection: {
        appId: context.target.appId,
        branch: context.target.branch,
        environment: "preview",
        projectId: context.target.projectId,
        sessionId: context.target.sessionId,
      },
      stage: "auth-bootstrap",
      version: 1,
    });
    let readonlyAttesters: NonNullable<HostedOperatorPlan["gatewayBindings"]>["readonlyAttesters"];
    if (
      configuration.workloadPolicy.environment === "production" &&
      configuration.nativeNeon.configuration.operator.environment === "preview"
    ) {
      const { workloadPolicy: builder } = configuration;
      const { operator } = configuration.nativeNeon.configuration;
      readonlyAttesters = {
        builderProduction: {
          audience: builder.audience,
          environment: "production",
          issuer: builder.issuer,
          ownerId: builder.ownerId,
          projectId: builder.projectId,
        },
        operatorPreview: {
          audience: operator.audience,
          environment: "preview",
          issuer: operator.issuer,
          ownerId: operator.ownerId,
          projectId: operator.projectId,
        },
      };
    }
    const gatewayPlan = hostedOperatorPlanSchema.parse({
      ...base,
      effects: [
        ...base.effects,
        {
          description:
            "Bind shared Auth only in the isolated Gateway/Auth project; retain existing signing and Auth secrets.",
          id: GATEWAY_BINDINGS,
          kind: GATEWAY_BINDINGS,
        },
        {
          description:
            "Deliver and pin an independently READY native Gateway Preview. Explicit approved retries may create duplicate deployments and usage charges.",
          id: GATEWAY_DELIVERY,
          kind: GATEWAY_DELIVERY,
        },
      ],
      gatewayBindings: {
        authBrowserOrigin: configuration.gateway.authBrowserOrigin,
        builderCallbackOrigin: configuration.builderCallbackOrigin,
        catalogAppIds: configuration.gateway.protectedApplicationIds,
        operatorOrigin: configuration.operator.origin,
        readonlyAttesters,
        sourceWorkload: configuration.gateway.workload,
      },
      gatewayDelivery: {
        branch: configuration.gateway.branch,
        gitSha: configuration.gateway.gitSha,
        projectId: configuration.gateway.projectId,
        repoId: configuration.gateway.repoId,
      },
    });
    return await resolveFullPlan(gatewayPlan, context, configuration, controlPlane);
  };

  const workerInput = async (input: HostedOperatorEffectContext) => {
    const [urls, generatedRelease] = await Promise.all([
      privateBindings(input),
      readRelease(controlPlane, input),
    ]);
    return {
      accessConnections: {
        appMigrator: urls.appDatabase.migrationUrl,
        appRuntime: urls.appDatabase.runtimeUrl,
        authMigrator: urls.authDatabase.migrationUrl,
        authRuntime: urls.authDatabase.runtimeUrl,
      },
      database: "appDatabase" as const,
      directDatabaseUrl: urls.appDatabase.migrationUrl,
      generatedRelease,
    };
  };
  const resources = async (
    input: HostedOperatorEffectContext,
    execute?: HostedOperatorWorkerEffectContext,
  ) => {
    const database =
      input.effect.resourceId === input.plan.authDatabase.resourceId
        ? ("authDatabase" as const)
        : ("appDatabase" as const);
    if (
      ![input.plan.authDatabase.resourceId, input.plan.appDatabase.resourceId].includes(
        input.effect.resourceId ?? "",
      )
    ) {
      throw new HostedOperatorError(RESOURCE_MISMATCH);
    }
    const resourceCredentials = await controlPlane.prepareResourceCredentials({
      ...input,
      database,
    });
    const authorityInput = {
      controlPlane,
      effect: execute ?? input,
      nativeStore: configuration.nativeNeon.configuration.nativeStore,
    };
    const authority =
      execute === undefined
        ? createNativePreviewNeonReconciliationAuthority(authorityInput)
        : createNativePreviewNeonExecutionAuthority({ ...authorityInput, effect: execute });
    const reader = createPreviewNeonMcpReader({
      ...authority,
      configuration: configuration.nativeNeon.configuration,
    });
    return await reader.withMaintenanceCredential(
      input,
      configuration.nativeNeon.scope,
      async ({ maintenanceUrl }) => {
        const privateInput = { database, directDatabaseUrl: maintenanceUrl, resourceCredentials };
        if (execute !== undefined) {
          await launcher.execute({ ...execute, ...privateInput });
        }
        return await launcher.inspect({ ...input, ...privateInput, readbackOnly: true });
      },
    );
  };
  const retirement = async (
    input: HostedOperatorEffectContext,
    execute?: HostedOperatorWorkerEffectContext,
  ) => {
    const resourceCredentials = await controlPlane.readRetirementResourceCredentials(input);
    const { nativeStore } = configuration.nativeNeon.configuration;
    const authority =
      execute === undefined
        ? createNativePreviewNeonReconciliationAuthority({
            controlPlane,
            effect: input,
            nativeStore,
          })
        : createNativePreviewNeonExecutionAuthority({ controlPlane, effect: execute, nativeStore });
    const reader = createPreviewNeonMcpReader({
      ...authority,
      configuration: configuration.nativeNeon.configuration,
    });
    return await reader.withMaintenanceCredential(
      input,
      configuration.nativeNeon.scope,
      async ({ maintenanceUrl }) => {
        const privateInput = {
          ...(await workerInput(input)),
          directDatabaseUrl: maintenanceUrl,
          resourceCredentials,
        };
        if (execute !== undefined) {
          await launcher.execute({ ...execute, ...privateInput });
        }
        return await launcher.inspect({ ...input, ...privateInput, readbackOnly: true });
      },
    );
  };
  const membershipInput = async (input: HostedOperatorEffectContext) => {
    const proof = await controlPlane.readCapturedRealmIdentityProof(input);
    if (
      input.plan.authMembership === undefined ||
      proof.link.proofSha256 !== input.plan.authMembership.identityProof.sha256 ||
      configuration.sandbox.membershipWorker === undefined
    ) {
      throw new HostedOperatorError(AUTH_MEMBERSHIP_REQUIRED);
    }
    const urls = await privateBindings(input);
    await input.assertCurrent();
    const oidcToken = await getVercelOidcToken({
      project: configuration.operator.projectId,
      team: configuration.teamId,
    });
    await input.assertCurrent();
    return {
      database: "authDatabase" as const,
      directDatabaseUrl: urls.authDatabase.migrationUrl,
      membershipProof: { oidcToken, proof: proof.proof },
    };
  };
  const reconcileResources = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    const observed = await resources(input);
    if (observed === null || observed === undefined || observed.status === "unknown") {
      return { status: "unknown" };
    }
    if (observed.status === "absent") {
      return { status: "absent" };
    }
    if (
      observed.status === "applied" &&
      "readback_sha256" in observed &&
      observed.readback_sha256 !== undefined
    ) {
      return { receipt: receipt(input, observed.readback_sha256), status: "applied" };
    }
    return { status: "unknown" };
  };
  const reconcileAuthSchema = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    try {
      const observed = await authReadiness.verify(input);
      return { receipt: receipt(input, observed.catalogFingerprint), status: "applied" };
    } catch {
      // The owned fixed catalog inspection below distinguishes genesis from an unreadable or partial migration.
      const urls = await privateBindings(input);
      const empty = await inspectEmptyAuthNamespace(urls.authDatabase.runtimeUrl, input);
      return empty ? { status: "absent" } : { status: "unknown" };
    }
  };
  const reconcileAppWorker = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    const observed = await launcher.inspect({
      ...input,
      ...(await workerInput(input)),
      readbackOnly: true,
    });
    if (
      observed?.status === "applied" &&
      "readback_sha256" in observed &&
      observed.readback_sha256 !== undefined
    ) {
      return { receipt: receipt(input, observed.readback_sha256), status: "applied" };
    }
    if (observed?.status === "absent") {
      return { status: "absent" };
    }
    if (
      observed?.status === "retryable" &&
      "readback_sha256" in observed &&
      observed.readback_sha256 !== undefined
    ) {
      return { resourceVersion: observed.readback_sha256, status: "retryable" };
    }
    return { status: "unknown" };
  };
  const reconcileBindings = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    if (input.checkpointManagedEnvironment === undefined) {
      throw new HostedOperatorError(OPERATION_IN_PROGRESS);
    }
    const observed = await appEnvironment.reconcile(
      { ...input, checkpointManagedEnvironment: input.checkpointManagedEnvironment },
      await bindings(input),
    );
    return observed.status === "applied"
      ? { receipt: receipt(input, hash(observed.rows)), status: "applied" }
      : observed;
  };
  const reconcileGatewayBindings = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    const observed = await gatewayEnvironment.reconcile(gatewayContext(input));
    return observed.status === "applied"
      ? { receipt: receipt(input, hash(observed.rows)), status: "applied" }
      : observed;
  };
  const reconcileDelivery = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    const observed = await (
      input.effect.kind === "delivery" ? appDelivery : gatewayDelivery
    ).reconcile(deliveryContext(input));
    if (observed.status === "applied") {
      return { receipt: receipt(input, hash(observed.selected)), status: "applied" };
    }
    return observed.status === "retryable"
      ? { resourceVersion: observed.resourceVersion, status: "retryable" }
      : { status: "unknown" };
  };
  const reconcileRemoveBindings = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    const observed = await appEnvironment.reconcile(managedContext(input), await bindings(input));
    if (observed.status === "absent") {
      return { receipt: receipt(input, hash({ rows: [] })), status: "applied" };
    }
    if (observed.status === "applied") {
      return { resourceVersion: hash(observed.rows), status: "retryable" };
    }
    return { status: "unknown" };
  };
  const reconcileRetire = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    const observed = await retirement(input);
    if (observed?.status === "applied" && observed.readback_sha256 !== undefined) {
      return { receipt: receipt(input, observed.readback_sha256), status: "applied" };
    }
    if (observed?.status === "retryable" && observed.readback_sha256 !== undefined) {
      return { resourceVersion: observed.readback_sha256, status: "retryable" };
    }
    return { status: "unknown" };
  };
  const reconcileAuthMembership = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    const observed = await launcher.inspect({
      ...input,
      assertCurrent: async () => {
        await controlPlane.assertMembershipCapture(input);
      },
      ...(await membershipInput(input)),
      readbackOnly: true,
    });
    if (observed?.status === "absent") {
      return { status: "absent" };
    }
    if (observed?.status === "applied" && observed.readback_sha256 !== undefined) {
      return { receipt: receipt(input, observed.readback_sha256), status: "applied" };
    }
    return { status: "unknown" };
  };
  const reconcileHandlers: Partial<
    Record<
      HostedOperatorPlan["effects"][number]["kind"],
      ProtectedHostedOperatorDependencies["reconcile"]
    >
  > = {
    access: reconcileAppWorker,
    "auth-membership": reconcileAuthMembership,
    bindings: reconcileBindings,
    delivery: reconcileDelivery,
    [GATEWAY_BINDINGS]: reconcileGatewayBindings,
    [GATEWAY_DELIVERY]: reconcileDelivery,
    install: reconcileAppWorker,
    "remove-bindings": reconcileRemoveBindings,
    resources: reconcileResources,
    retire: reconcileRetire,
    revoke: reconcileAppWorker,
  };
  const reconcile: ProtectedHostedOperatorDependencies["reconcile"] = async (input) => {
    await input.assertCurrent();
    await controlPlane.assertAuthorized(input);
    if (input.effect.kind === "install" && input.effect.id === AUTH_SCHEMA_EFFECT) {
      return await reconcileAuthSchema(input);
    }
    const handler = reconcileHandlers[input.effect.kind];
    if (handler === undefined) {
      throw new HostedOperatorError(OPERATION_IN_PROGRESS);
    }
    return await handler(input);
  };
  const executeEffectResources = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    const observed = await resources(input, input);
    if (
      observed?.status !== "applied" ||
      !("readback_sha256" in observed && observed.readback_sha256 !== undefined)
    ) {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    return receipt(input, observed.readback_sha256);
  };
  const executeEffectAuthSchema = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    if (input.plan.authSchema === undefined) {
      throw new HostedOperatorError(RESOURCE_MISMATCH);
    }
    const authSchemaPlan = await controlPlane.readAuthPlan(input, input.plan.authSchema);
    const urls = await privateBindings(input);
    await launcher.execute({
      ...input,
      authSchemaPlan,
      database: "authDatabase",
      directDatabaseUrl: urls.authDatabase.migrationUrl,
    });
    const observed = await authReadiness.verify(input);
    return receipt(input, observed.catalogFingerprint);
  };
  const executeEffectAppWorker = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    await launcher.execute({ ...input, ...(await workerInput(input)) });
    const observed = await reconcile(input);
    if (observed.status !== "applied") {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    return observed.receipt;
  };
  const executeEffectBindings = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    if (input.checkpointManagedEnvironment === undefined) {
      throw new HostedOperatorError(OPERATION_IN_PROGRESS);
    }
    const observed = await appEnvironment.bind(
      { ...input, checkpointManagedEnvironment: input.checkpointManagedEnvironment },
      await bindings(input),
    );
    return receipt(input, hash(observed.rows));
  };
  const executeEffectGatewayBindings = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    const observed = await gatewayEnvironment.bind(gatewayContext(input));
    return receipt(input, hash(observed.rows));
  };
  const executeEffectDelivery = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    const observed = await (
      input.effect.kind === "delivery" ? appDelivery : gatewayDelivery
    ).deliver(deliveryContext(input));
    if (observed.status !== "applied") {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    return receipt(input, hash(observed.selected));
  };
  const executeEffectRemoveBindings = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    const observed = await appEnvironment.remove(managedContext(input), await bindings(input));
    return receipt(input, hash(observed.rows));
  };
  const executeEffectRetire = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    const observed = await retirement(input, input);
    if (observed?.status !== "applied" || observed.readback_sha256 === undefined) {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    return receipt(input, observed.readback_sha256);
  };
  const executeEffectAuthMembership = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    await launcher.execute({
      ...input,
      assertCurrent: async () => {
        await controlPlane.assertMembershipCapture(input);
      },
      ...(await membershipInput(input)),
    });
    const observed = await reconcile(input);
    if (observed.status !== "applied") {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    return observed.receipt;
  };
  const executeEffectHandlers: Partial<
    Record<
      HostedOperatorPlan["effects"][number]["kind"],
      ProtectedHostedOperatorDependencies["executeEffect"]
    >
  > = {
    access: executeEffectAppWorker,
    "auth-membership": executeEffectAuthMembership,
    bindings: executeEffectBindings,
    delivery: executeEffectDelivery,
    [GATEWAY_BINDINGS]: executeEffectGatewayBindings,
    [GATEWAY_DELIVERY]: executeEffectDelivery,
    install: executeEffectAppWorker,
    "remove-bindings": executeEffectRemoveBindings,
    resources: executeEffectResources,
    retire: executeEffectRetire,
    revoke: executeEffectAppWorker,
  };
  const executeEffect: ProtectedHostedOperatorDependencies["executeEffect"] = async (input) => {
    await input.assertCurrent();
    await controlPlane.assertAuthorized(input);
    if (input.effect.kind === "install" && input.effect.id === AUTH_SCHEMA_EFFECT) {
      return await executeEffectAuthSchema(input);
    }
    const handler = executeEffectHandlers[input.effect.kind];
    if (handler === undefined) {
      throw new HostedOperatorError(OPERATION_IN_PROGRESS);
    }
    return await handler(input);
  };
  const authIdentityInput: NonNullable<
    ProtectedHostedOperatorDependencies["authIdentityInput"]
  > = async (input) => {
    await controlPlane.assertPlanningAuthorized(input);
    const current = await controlPlane.store.read(input);
    const operator = current?.record.operator;
    if (current === undefined || operator === undefined) {
      throw new HostedOperatorError(OPERATION_IN_PROGRESS);
    }
    const knownPrepared = [
      operator.operationRef === input.operationRef,
      operator.plan.stage === "auth-bootstrap",
      operator.authPreparation !== undefined,
      current.record.leaseId === undefined,
      operator.pendingEffectId === undefined,
      operator.pendingEffectAttempt === undefined,
      operator.plan.effects.every((effect) =>
        operator.receipts.some((observedReceipt) => observedReceipt.effectId === effect.id),
      ),
    ].every(Boolean);
    if (!knownPrepared) {
      throw new HostedOperatorError(OPERATION_IN_PROGRESS);
    }
    const candidate = operator.gatewayDeliveryCandidates?.find(
      (value) =>
        value.deploymentId === operator.deliveredGatewayDeploymentId &&
        value.readyState === "READY",
    );
    const boundary = operator.plan.deploymentBoundary;
    const { gatewayBindings } = operator.plan;
    if (candidate === undefined || boundary === undefined || gatewayBindings === undefined) {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    await readHostedOperatorProviderInventory({
      phase: "bootstrap-planning",
      assertCurrentOwner: async () => {
        await controlPlane.assertPlanningAuthorized(input);
      },
      configuration: {
        app: {
          branch: boundary.app.branch,
          deploymentId: boundary.app.deploymentId,
          environment: "preview",
          projectId: boundary.app.projectId,
        },
        gateway: {
          branch: candidate.branch,
          deploymentId: candidate.deploymentId,
          environment: "preview",
          projectId: candidate.projectId,
        },
        operator: boundary.operator,
        verification: {
          gatewayOrigin: candidate.origin,
          publicOrigin: boundary.verification.publicOrigin,
        },
      },
      context: input,
      readVercelCredential: async ({ authority, installationId }) =>
        await controlPlane.readCredential(authority, installationId),
    });
    const pending = await controlPlane.prepareRealmIdentityLink({
      audience: gatewayBindings.operatorOrigin,
      authResourceId: operator.plan.authDatabase.resourceId,
      bootstrapPlanDigest: operator.planDigest,
      browserOrigin: gatewayBindings.authBrowserOrigin,
      context: input,
      endpointOrigin: candidate.origin,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      issuer: boundary.verification.publicOrigin,
      organizationId: null,
    });
    return {
      browserUrl: createRealmIdentityBrowserUrl(pending),
      expiresAt: pending.link.expiresAt,
      operationRef: input.operationRef,
      sessionId: input.target.sessionId,
    };
  };
  return {
    assertAuthorized: controlPlane.assertAuthorized,
    authIdentityInput,
    authorize: controlPlane.authorize,
    bindings,
    executeEffect,
    plan,
    readApproval: controlPlane.readApproval,
    reconcile,
    store: controlPlane.store,
    verify: async (input) => {
      await controlPlane.assertAuthorized(input);
      const row = await controlPlane.store.read(input);
      const operator = row?.record.operator;
      const app = operator?.deliveryCandidates?.find(
        (candidate) =>
          candidate.deploymentId === operator.deliveredDeploymentId &&
          candidate.readyState === "READY",
      );
      const gateway = operator?.gatewayDeliveryCandidates?.find(
        (candidate) =>
          candidate.deploymentId === operator.deliveredGatewayDeploymentId &&
          candidate.readyState === "READY",
      );
      if (
        app === undefined ||
        gateway === undefined ||
        input.plan.deploymentBoundary === undefined
      ) {
        throw new HostedOperatorError(RECONCILIATION_REQUIRED);
      }
      await readHostedOperatorProviderInventory({
        assertCurrentOwner: async () => {
          await controlPlane.assertAuthorized(input);
          await privateBindings(input);
        },
        configuration: {
          app: {
            branch: app.branch,
            deploymentId: app.deploymentId,
            environment: "preview",
            projectId: app.projectId,
          },
          gateway: {
            branch: gateway.branch,
            deploymentId: gateway.deploymentId,
            environment: "preview",
            projectId: gateway.projectId,
          },
          operator: configuration.operator,
          verification: {
            gatewayOrigin: gateway.origin,
            publicOrigin: input.plan.deploymentBoundary.verification.publicOrigin,
          },
        },
        context: input,
        readVercelCredential: async ({ authority, installationId }) =>
          await controlPlane.readCredential(authority, installationId),
      });
      return await appReadiness({
        ...input,
        assertCurrent: async () => {
          await controlPlane.assertAuthorized(input);
          await privateBindings(input);
        },
      });
    },
    verifyAuthReadiness: async (input) => await authReadiness.verify(input),
    withResourceLease: controlPlane.withResourceLease,
  };
};

export const createDependencies = async (): Promise<ProtectedHostedOperatorDependencies> => {
  const { configuration, controlPlane } = await openHostedOperatorCompositionResources();
  return composeHostedOperatorDependencies(configuration, controlPlane);
};
