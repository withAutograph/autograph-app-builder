/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity, sonarjs/expression-complexity -- The closed native adapter checks distinct canonical owner, source, central workload, physical SQL and durable effect authorities. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { ReadCentralIntegrationHostReady } from "./app-integration-central-authority";
import type { ReadCentralIntegrationHostPrivate } from "./app-integration-capability-deployment";
import { createPostgresAppIntegrationCapabilityStore } from "./app-integration-capability-store";
import {
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityPlanDigest,
  canonicalAppIntegrationCapabilityPlanBytes,
} from "./app-integration-capability-contract";
import {
  appIntegrationReleaseAttachmentSchema,
  appIntegrationRemovalSchema,
  appIntegrationRemovalFenceProofSchema,
} from "./app-integration-release-contract";
import type { AppIntegrationRemoval } from "./app-integration-release-contract";
import type {
  PublicReleaseIntegrationRemovalPorts,
  PublicReleaseIntegrationRemovalEffectContext,
} from "./public-release-integration-removal";
import type { PublicReleaseInvocation } from "./public-release-handler";
import {
  publicReleaseOperationRef,
  publicReleasePlanDigest,
  publicReleasePlanSchema,
} from "./public-release-contract";
import {
  readCentralIntegrationPrivateProfile,
  centralIntegrationPrivateProfileDigest,
} from "./central-integration-private-profile";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import { runAppIntegrationFileSpool } from "./hosted-operator-sandbox-launcher";
import type {
  ProtectedInstallContextWire,
  HostedOperatorSandboxConfiguration,
} from "./hosted-operator-sandbox-launcher";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";

const fail = () =>
  new PublicReleasePrerequisiteError("public_release_integration_removal_required");
const readObserverResponse = async (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) {throw fail();}
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve stream backpressure and the fixed response byte bound.
      const part = await reader.read();
      if (part.done) {break;}
      bytes += part.value.byteLength;
      // This response is a fixed readiness/removal marker, never provider records or a binding list.
      if (bytes > 32_768) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel the same owned reader before rejecting an oversized marker.
        await reader.cancel();
        throw fail();
      }
      chunks.push(part.value);
    }
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
  } finally {
    reader.releaseLock();
  }
};
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const canonicalHash = (value: z.infer<typeof appIntegrationRemovalFenceProofSchema>) =>
  sha(centralHostCanonicalBytes(z.json().parse(value)));
const current =
  (invocation: PublicReleaseInvocation, assertCurrent: () => Promise<void>) => async () => {
    invocation.signal.throwIfAborted();
    await assertCurrent();
    invocation.signal.throwIfAborted();
  };
/** Native-only assembly. Missing custody/central infrastructure remains a prerequisite, never successful removal. */
export const createPublicReleaseIntegrationRemovalAdapter = (input: {
  database?: ReturnType<typeof openHostedPostgresDatabase>;
  configuration?: { sandbox: HostedOperatorSandboxConfiguration };
  environment: Readonly<Record<string, string | undefined>>;
  readCentralReady?: ReadCentralIntegrationHostReady;
  readCentralPrivate?: ReadCentralIntegrationHostPrivate;
  readInspectorToken?: () => Promise<string>;
  fetch?: typeof fetch;
  run?: typeof runAppIntegrationFileSpool;
  capabilityStore?: Pick<ReturnType<typeof createPostgresAppIntegrationCapabilityStore>, "read">;
}): PublicReleaseIntegrationRemovalPorts => {
  const store =
    input.capabilityStore ??
    (input.database === undefined
      ? undefined
      : createPostgresAppIntegrationCapabilityStore(input.database));
  const load = async (
    invocation: PublicReleaseInvocation,
    sourceCapability: { operationRef: string; planDigest: string },
    scopeSha256: string,
    assert: () => Promise<void>,
  ) => {
    const assertCurrent = current(invocation, assert);
    await assertCurrent();
    if (store === undefined) {throw fail();}
    const row = await store.read(invocation.authority, sourceCapability.operationRef);
    await assertCurrent();
    if (
      !row ||
      !row.record.prepared ||
      row.record.approvalReceipts.length === 0 ||
      Object.values(row.record.effects).some((value) => value.state !== "applied") ||
      row.record.planDigest !== sourceCapability.planDigest ||
      appIntegrationCapabilityPlanDigest(row.record.plan) !== sourceCapability.planDigest ||
      appIntegrationCapabilityOperationRef(row.record.plan) !== sourceCapability.operationRef ||
      !isDeepStrictEqual(row.record.plan.authority, invocation.authority)
    )
      {throw fail();}
    const plan = row.record.plan;
    const attachment = appIntegrationReleaseAttachmentSchema.parse({
      ...sourceCapability,
      capability: row.record.prepared,
      scopeSha256,
      readinessPath: plan.readinessPath,
    });
    const configuration = input.configuration;
      const readCentralReady = input.readCentralReady;
      const readPrivate = input.readCentralPrivate;
    const worker = configuration?.sandbox.integrationWorker;
    if (
      !configuration ||
      !readCentralReady ||
      !readPrivate ||
      !worker ||
      worker.id !== "app-integration-bootstrap-v1" ||
      worker.operationScope !== "app-integration-bootstrap-v1"
    )
      {throw fail();}
    const profile = readCentralIntegrationPrivateProfile(input.environment);
    if (!profile.owners.some((owner) => isDeepStrictEqual(owner, invocation.authority)))
      {throw fail();}
    const central = await readCentralReady({
      authority: invocation.authority,
      appId: plan.selection.appId,
      appProjectId: plan.project.projectId,
      teamId: plan.project.teamId,
      assertCurrentOwner: assertCurrent,
      signal: invocation.signal,
    });
    await assertCurrent();
    if (
      !central ||
      central.profile.id !== profile.id ||
      central.profile.digest !== centralIntegrationPrivateProfileDigest(profile) ||
      central.setup.operationRef !== plan.control.centralHostSetup.operationRef ||
      central.setup.planDigest !== plan.control.centralHostSetup.planDigest ||
      central.callerSetup.operationRef !== plan.control.centralHostSetup.callerOperationRef ||
      central.callerSetup.planDigest !== plan.control.centralHostSetup.callerPlanDigest ||
      central.deployment.providerDeploymentId !==
        plan.control.centralHostSetup.providerDeploymentId ||
      central.deployment.immutableOrigin !== plan.control.origin ||
      central.resourceProfileId !== plan.control.resourceProfileId ||
      central.caller.projectId !== plan.project.projectId ||
      central.caller.ownerId !== plan.project.teamId ||
      central.caller.trustedSourcesGrantSha256 !==
        plan.control.centralHostSetup.trustedSourcesGrantSha256 ||
      central.control.resource.hostname !== plan.control.database.hostname ||
      central.control.resource.database !== plan.control.database.database ||
      central.control.resource.migratorRole !== plan.control.database.migratorRole ||
      central.control.schemaSha256 !== plan.control.schema.sha256 ||
      central.activation.keyId !== plan.control.activationKeyId ||
      central.activation.publicKeySha256 !== plan.control.activationPublicKeySha256
    )
      {throw fail();}
    return {
      invocation,
      plan,
      attachment,
      configuration,
      worker,
      profile,
      central,
      assertCurrent,
      readPrivate,
    };
  };
  const observe = async (
    scope: Awaited<ReturnType<typeof load>>,
    expected?: { removal: AppIntegrationRemoval; operationRef: string },
  ) => {
    await scope.assertCurrent();
    const { central, profile, plan } = scope;
    const manifest = {
      applicationIngress: profile.source.applicationIngress,
      deploymentProfile: profile.source.deploymentProfile,
      profileId: central.profile.id,
      profileDigest: central.profile.digest,
      resourceProfileId: central.resourceProfileId,
      configurationRef: central.deployment.configurationRef,
      configurationSha256: central.deployment.configurationSha256,
      control: {
        hostname: central.control.resource.hostname,
        port: central.control.resource.port,
        database: central.control.resource.database,
        schema: "public",
        runtimeRole: central.control.centralRuntimeRole,
        neon: central.control.neon,
        schemaSha256: central.control.schemaSha256,
      },
      activation: {
        keyId: central.activation.keyId,
        publicKeySha256: central.activation.publicKeySha256,
      },
      deployment: {
        projectId: central.deployment.projectId,
        teamId: central.deployment.teamId,
        environment: "preview",
        serviceId: "integrations",
      },
    };
    const token = await (input.readInspectorToken ?? getVercelOidcToken)();
    await scope.assertCurrent();
    const response = await (input.fetch ?? fetch)(
      new URL("/integrations/internal/central-readiness", central.deployment.immutableOrigin),
      {
        method: "POST",
        redirect: "error",
        signal: scope.invocation.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-vercel-trusted-oidc-idp-token": token,
        },
        body: JSON.stringify({
          ...manifest,
          providerDeploymentId: central.deployment.providerDeploymentId,
          inspection: {
            action: "inspect-app-removal",
            appId: plan.selection.appId,
            sourceCapability: {
              operationRef: appIntegrationCapabilityOperationRef(plan),
              planDigest: appIntegrationCapabilityPlanDigest(plan),
            },
            scopeSha256: scope.attachment.scopeSha256,
            ...(expected === undefined ? {} : { expected }),
          },
        }),
      },
    );
    await scope.assertCurrent();
    if (response.status !== 200) {throw fail();}
    const data = z.record(z.string(), z.unknown()).parse(await readObserverResponse(response));
    for (const [key, value] of Object.entries(manifest))
      {if (key !== "deployment" && !isDeepStrictEqual(data[key], value)) {
        throw fail();
      }}
    if (
      data.version !== 1 ||
      data.kind !== "central-integrations-readiness-v1" ||
      !isDeepStrictEqual(data.deployment, {
        ...manifest.deployment,
        providerDeploymentId: central.deployment.providerDeploymentId,
        immutableOrigin: central.deployment.immutableOrigin,
      })
    )
      {throw fail();}
    const worker = {
      reference: "app-integration-bootstrap-v1" as const,
      sha256: scope.worker.sha256,
    };
    const observed = z.record(z.string(), z.unknown()).parse(data.appRemoval);
    if (observed.worker !== undefined && !isDeepStrictEqual(observed.worker, worker)) {throw fail();}
    const removal = appIntegrationRemovalSchema.parse({ ...observed, worker });
    const fence =
      data.removalFence === undefined
        ? undefined
        : appIntegrationRemovalFenceProofSchema.parse(data.removalFence);
    if (
      removal.sourceCapability.operationRef !== appIntegrationCapabilityOperationRef(plan) ||
      removal.sourceCapability.planDigest !== appIntegrationCapabilityPlanDigest(plan) ||
      removal.scopeSha256 !== scope.attachment.scopeSha256 ||
      removal.authority.principalName !== plan.control.database.runtimeRole ||
      removal.authority.principalGeneration !==
        scope.attachment.capability.control.principalGeneration ||
      removal.authority.configurationRef !==
        scope.attachment.capability.privateConfiguration.reference ||
      removal.authority.configurationSha256 !==
        scope.attachment.capability.privateConfiguration.sha256 ||
      (expected && !isDeepStrictEqual(expected.removal, removal)) ||
      (fence &&
        (!expected ||
          fence.operationRef !== expected.operationRef ||
          fence.priorGeneration !== removal.authority.principalGeneration ||
          fence.principalGeneration !== removal.authority.expectedFencedGeneration ||
          fence.stoppedBindingsSha256 !== removal.stoppedBindingsSha256))
    )
      {throw fail();}
    await scope.assertCurrent();
    return { removal, fence };
  };
  const prepare = async (context: PublicReleaseIntegrationRemovalEffectContext) => {
    const plan = publicReleasePlanSchema.parse(context.plan);
      const removal = plan.integrationRemoval;
    if (
      !removal ||
      context.effect !== "fence-app-integration-authority" ||
      publicReleaseOperationRef(plan) !== context.operationRef ||
      plan.selection.sessionId !== context.invocation.sessionId ||
      !isDeepStrictEqual(plan.authority, context.invocation.authority)
    )
      {throw fail();}
    const scope = await load(
      context.invocation,
      removal.sourceCapability,
      removal.scopeSha256,
      context.assertCurrent,
    );
    if (
      !isDeepStrictEqual(scope.plan.project, {
        projectId: plan.project.projectId,
        teamId: plan.project.teamId,
        installationId: plan.project.installationId,
        provisioningRequestId: plan.project.provisioningRequestId,
        provisioningDigest: plan.project.provisioningDigest,
      }) ||
      removal.worker.reference !== scope.worker.id ||
      removal.worker.sha256 !== scope.worker.sha256
    )
      {throw fail();}
    return { scope, plan, removal };
  };
  const run = async (context: PublicReleaseIntegrationRemovalEffectContext, readOnly: boolean) => {
    const { scope, plan, removal } = await prepare(context);
    const values = await scope.readPrivate(scope.central, scope.assertCurrent);
    await scope.assertCurrent();
    const url = new URL(values.controlMigratorUrl);
      const resource = scope.plan.control.database;
    const production = values.productionControlDatabaseIdentity
      .split("/")[0]
      ?.replace(/-pooler(?=\.)/u, "");
    if (
      !production ||
      production === url.hostname.replace(/-pooler(?=\.)/u, "") ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== resource.hostname ||
      url.hostname.includes("-pooler") ||
      Number(url.port || 5432) !== resource.port ||
      decodeURIComponent(url.username) !== resource.migratorRole ||
      decodeURIComponent(url.pathname.slice(1)) !== resource.database ||
      !url.password ||
      url.hash ||
      url.searchParams.getAll("sslmode").length !== 1 ||
      !["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "") ||
      [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))
    )
      {throw fail();}
    const digest = publicReleasePlanDigest(plan);
    const expectedReceipt = {
      operationRef: context.operationRef,
      active: false as const,
      principalGeneration: removal.authority.expectedFencedGeneration,
      priorGeneration: removal.authority.principalGeneration,
      stoppedBindingsSha256: removal.stoppedBindingsSha256,
    };
    const wire: ProtectedInstallContextWire = {
      version: 1,
      operation: {
        operation_id: context.operationRef,
        approval_digest: digest,
        fence_generation: removal.authority.expectedFencedGeneration,
      },
      app_id: plan.selection.appId,
      resource: {
        resource_id: resource.resourceId,
        environment: "preview",
        hostname: resource.hostname,
        port: resource.port,
        database: resource.database,
        schema: "public",
        migrator_role: resource.migratorRole,
        runtime_role: resource.runtimeRole,
        provider_project_id: scope.plan.control.neon.projectId,
        provider_branch_id: scope.plan.control.neon.branchId,
      },
      release: { id: plan.runtime.releaseId, sha256: digest },
      installer: { id: removal.worker.reference, sha256: removal.worker.sha256 },
      tenant_targets: scope.plan.serviceMemberships.map((row) => row.organizationId).toSorted(),
    };
    const result = await (input.run ?? runAppIntegrationFileSpool)(scope.configuration.sandbox, {
      worker: {
        ...scope.worker,
        subcommand: readOnly
          ? "integration-fence-app-authority-readback"
          : "integration-fence-app-authority",
      },
      context: wire,
      runId: randomUUID(),
      directDatabaseUrl: values.controlMigratorUrl,
      startupFiles: {
        "app-integration-removal-approved-plan.json": Buffer.from(JSON.stringify(plan)),
        "app-integration-removal-source-plan.json": Buffer.from(
          canonicalAppIntegrationCapabilityPlanBytes(scope.plan),
        ),
        "app-integration-removal-connections.json": Buffer.from(
          JSON.stringify({ controlMigrator: values.controlMigratorUrl }),
        ),
      },
      readOnly,
      signal: context.invocation.signal,
      assertCurrent: scope.assertCurrent,
      ...(readOnly
        ? {}
        : {
            authorizeAppIntegrationRemoval: async () => {
              const actual = await observe(scope);
              if (actual.fence || !isDeepStrictEqual(actual.removal, removal)) {throw fail();}
            },
            recordCheckpoint: async (frame) => {
              await scope.assertCurrent();
              if (
                frame.operationId !== context.operationRef ||
                frame.effectId !== "fence-app-integration-authority" ||
                frame.receipt.state !== "applied" ||
                frame.receipt.readbackSha256 !== canonicalHash(expectedReceipt)
              )
                {throw fail();}
              const actual = await observe(scope, { operationRef: context.operationRef, removal });
              if (!isDeepStrictEqual(actual.fence, expectedReceipt)) {throw fail();}
            },
          }),
    });
    await scope.assertCurrent();
    if (!readOnly) {
      // The existing mutating file-spool transport returns no readback object. Its genuine checkpoint ACK and the independently observed SQL receipt carry authority.
      const actual = await observe(scope, { operationRef: context.operationRef, removal });
      if (!isDeepStrictEqual(actual.fence, expectedReceipt)) {throw fail();}
      return "applied" as const;
    }
    const observed = z
      .object({
        status: z.enum(["applied", "not-applied", "unknown"]),
        receipt: appIntegrationRemovalFenceProofSchema.optional(),
        readback_sha256: z.string().optional(),
      })
      .parse(result);
    if (observed.status === "applied") {
      if (
        !isDeepStrictEqual(observed.receipt, expectedReceipt) ||
        observed.readback_sha256 !== canonicalHash(expectedReceipt)
      )
        {throw fail();}
      const actual = await observe(scope, { operationRef: context.operationRef, removal });
      if (!isDeepStrictEqual(actual.fence, expectedReceipt)) {throw fail();}
    }
    return observed.status;
  };
  return {
    readPreflight: async (context) => {
      try {
        const scope = await load(
          context.invocation,
          context.sourceCapability,
          context.sourceCapability.scopeSha256,
          context.assertCurrent,
        );
        if (!isDeepStrictEqual(scope.attachment, context.sourceCapability)) {throw fail();}
        const observed = await observe(scope, context.expected);
        return observed.removal;
      } catch {
        context.invocation.signal.throwIfAborted();
        throw fail();
      }
    },
    reconcile: async (context) => {
      try {
        return await run(context, true);
      } catch {
        context.invocation.signal.throwIfAborted();
        return "unknown";
      }
    },
    apply: async (context) => {
      try {
        if (context.priorPhase === "pending" && (await run(context, true)) !== "not-applied")
          {throw fail();}
        if ((await run(context, false)) !== "applied") {throw fail();}
      } catch {
        context.invocation.signal.throwIfAborted();
        throw fail();
      }
    },
  };
};
