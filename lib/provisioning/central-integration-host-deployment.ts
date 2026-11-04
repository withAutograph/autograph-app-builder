import type { AppIntegrationCentralPrivateValues } from "./app-integration-capability-deployment";
import {
  verifyCentralNativeDeploymentReceipt,
  retainCentralNativeDeploymentReceipt,
} from "./central-integration-deployment-receipt";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { createPostgresHostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import type { PublicReleaseRequestAuthority } from "./public-release-dispatcher";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type { HostedOperatorSandboxConfiguration } from "./hosted-operator-sandbox-launcher";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { ReadOwnedBuilderDestination } from "./owned-builder-runtime";
import type { PublicReleaseInvocation } from "./public-release-handler";
import { createCentralHostDispatcher } from "./central-integration-host-dispatcher";
import { createCentralHostApprovalAuthority } from "./central-integration-host-approval";
import { createCentralHostTargetLease } from "./central-integration-host-lease";
import { createCentralIntegrationVercelProvider } from "./central-integration-vercel-provider";
import { createCentralHostGitHubProvider } from "./central-integration-github-provider";
import { createOwnerScopedGitHubRepositoryCredentialReader } from "./public-release-github-credential";
import { createCentralHostObservation } from "./central-integration-host-observation";
import {
  createPostgresCentralHostStore,
  createReadCentralIntegrationHostReady,
} from "./central-integration-host-store";
import type { CentralHostRow } from "./central-integration-host-store";
import {
  centralHostSetupPlanSchema,
  centralHostCallerPlanSchema,
  centralHostPlanDigest,
  centralHostOperationRef,
  centralHostReadyReceiptSchema,
} from "./central-integration-host-contract";
import type {
  CentralHostSetupPlan,
  CentralHostCallerPlan,
} from "./central-integration-host-contract";
import { createCentralHostPlanSelection } from "./central-integration-plan-selection";
import {
  readCentralIntegrationPrivateProfile,
  centralIntegrationPrivateProfileDigest,
  resolveCentralRuntimeConfiguration,
  readCentralRuntimeConfiguration,
} from "./central-integration-private-profile";
import {
  centralIntegrationPrivateSeedSchema,
  centralAcceptedReceiverSchema,
} from "./central-integration-private-custody";
import { CentralHostPrerequisiteError } from "./central-integration-host-prerequisite";
import type {
  CentralHostServicePorts,
  CentralHostEffectContext,
} from "./central-integration-host-service";
import type { CentralEffectReceipt } from "./central-integration-host-checkpoint";
import { createCentralIntegrationSourceCapture } from "./central-integration-source-capture";
import { createCentralIntegrationSandboxWorker } from "./central-integration-sandbox-worker";

type Plan = CentralHostSetupPlan | CentralHostCallerPlan;
const fail = () => new Error("central_host_composition_unavailable");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface CentralHostDeploymentInput {
  request?: Request;
  database: ReturnType<typeof openHostedPostgresDatabase>;
  databaseUrl: string;
  keyring: VercelTokenKeyringConfig;
  environment: Readonly<Record<string, string | undefined>>;
  builderOrigin: string;
  configuration: Pick<
    HostedOperatorSourceConfiguration,
    "operator" | "builderCallbackOrigin" | "workloadPolicy"
  > & {
    sandbox: HostedOperatorSandboxConfiguration;
  };
  owner: PublicReleaseRequestAuthority & { readStandardDestination: ReadOwnedBuilderDestination };
  readSourceOwner: (
    authority: OperatorOwnerContext["authority"],
    target: { appId: string; sessionId: string },
  ) => Promise<OperatorOwnerContext>;
  fetch?: typeof fetch;
  readInspectorToken?: () => Promise<string>;
  runSourceCapture?: Parameters<typeof createCentralIntegrationSourceCapture>[0]["run"];
}
/** Real protected composition. Missing deployment configuration is a prerequisite, never a synthetic profile. */
export const createCentralHostDeployment = (input: CentralHostDeploymentInput) => {
  const store = createPostgresCentralHostStore(input.database);
  const captureSource = createCentralIntegrationSourceCapture({
    configuration: input.configuration.sandbox,
    run: input.runSourceCapture,
  });
  const profile = () => {
    try {
      const selected = readCentralIntegrationPrivateProfile(input.environment);
      if (
        selected.receiver.publicOrigin !== input.configuration.builderCallbackOrigin ||
        selected.inspector.projectId !== input.configuration.operator.projectId ||
        selected.inspector.environment !== input.configuration.operator.environment
      )
        {throw fail();}
      return selected;
    } catch {
      throw new CentralHostPrerequisiteError("central_host_profile_required");
    }
  };
  const ownerFor = async (plan: Plan) => {
    const owner = await input.readSourceOwner(plan.authority, {
      appId: plan.selection.initiatingAppId,
      sessionId: plan.selection.sessionId,
    });
    await input.owner.assertCanonicalAppOwner({
      authority: plan.authority,
      ownerContext: owner,
      target: { appId: plan.selection.initiatingAppId, sessionId: plan.selection.sessionId },
    });
    return owner;
  };
  const authorize = async (invocation: PublicReleaseInvocation, plan: Plan) => {
    invocation.signal.throwIfAborted();
    const current = profile();
    if (
      !current.owners.some((authority) => isDeepStrictEqual(authority, plan.authority)) ||
      current.id !== plan.profile.id ||
      centralIntegrationPrivateProfileDigest(current) !== plan.profile.digest
    )
      {throw fail();}
    if (
      !isDeepStrictEqual(invocation.authority, plan.authority) ||
      invocation.sessionId !== plan.selection.sessionId
    )
      {throw fail();}
    const owner = await ownerFor(plan);
    if (plan.kind === "central-integration-host-caller-v1") {
      const normal = await input.owner.readStandardDestination({
        authority: plan.authority,
        ownerContext: owner,
        target: { appId: plan.selection.initiatingAppId, sessionId: plan.selection.sessionId },
      });
      if (
        normal === undefined ||
        normal.projectId !== plan.caller.projectId ||
        normal.teamId !== plan.caller.ownerId ||
        normal.provisioningRequestId !== plan.caller.provisioningRequestId ||
        normal.provisioningDigest !== plan.caller.provisioningDigest
      ) {
        throw fail();
      }
    }
    invocation.signal.throwIfAborted();
  };
  const frozen = async (invocation: PublicReleaseInvocation, plan: CentralHostSetupPlan) => {
    await authorize(invocation, plan);
    const current = profile();
    if (
      !isDeepStrictEqual(plan.target, current.target) ||
      !isDeepStrictEqual(plan.control, current.control) ||
      !isDeepStrictEqual(plan.provider, current.provider)
    )
      {throw fail();}
    const values = await readCentralRuntimeConfiguration({
      database: input.database,
      keyring: input.keyring,
      profile: current,
      authority: plan.authority,
      assertCurrent: () => authorize(invocation, plan),
      configurationRef: plan.source.configurationRef,
      configurationSha256: plan.source.configurationSha256,
      profileDigest: plan.profile.digest,
    });
    if (
      values === undefined ||
      !isDeepStrictEqual(values.activation, plan.activation) ||
      !isDeepStrictEqual(
        Object.entries(values.values)
          .map(([key, value]) => ({ key, sha256: hash(value) }))
          .toSorted((a, b) => a.key.localeCompare(b.key)),
        plan.environment,
      )
    )
      {throw fail();}
    return values;
  };
  const compose = (
    request: Request,
    ownerContext: OperatorOwnerContext,
    assertCurrentOwner: () => Promise<void>,
  ) => {
    const invocationFor = (plan: Plan): PublicReleaseInvocation => ({
      authority: plan.authority,
      sessionId: plan.selection.sessionId,
      callId: "historical-read",
      signal: request.signal,
    });
    const approval = async (invocation: PublicReleaseInvocation, plan: Plan, callId: string) => {
      await authorize(invocation, plan);
      const owner = await ownerFor(plan);
      return await createCentralHostApprovalAuthority({
        database: input.database,
        builderOrigin: input.builderOrigin,
        request,
        owner,
        authority: input.owner,
        assertCurrentOwner: () => authorize(invocation, plan),
        fetch: input.fetch,
      })(plan, callId);
    };
    const history = async (plan: Plan) => {
      const invocation = invocationFor(plan);
      await authorize(invocation, plan);
      const row = await store.read(plan.authority, centralHostOperationRef(plan));
      if (row === undefined) {throw fail();}
      for (const receipt of row.record.approvalReceipts ?? [])
        {await approval(invocation, plan, receipt.approvedByCallId);}
    };
    let effect: CentralHostEffectContext | undefined;
    const provider = createCentralIntegrationVercelProvider({
      assertCurrent: async (plan, consent) => {
        await authorize(invocationFor(plan), plan);
        await assertCurrentOwner();
        if (consent) {
          if (effect === undefined || !isDeepStrictEqual(effect.plan, plan)) {throw fail();}
          await effect.assertCurrent();
        }
      },
      readCredential: (plan) =>
        readActiveVercelInstallationToken({
          database: input.database,
          config: input.keyring,
          authority:
            plan.kind === "central-integration-host-caller-v1"
              ? plan.setupAuthority
              : plan.authority,
          installationId: (plan.kind === "central-integration-host-setup-v1"
            ? plan.target
            : plan.central
          ).installationId,
        }),
      readRuntimeBindings: async (plan) => {
        const retained = await frozen(invocationFor(plan), plan);
        return Object.entries(retained.values).map(([key, value]) => ({ key, value }));
      },
      fetch: input.fetch,
    });
    const githubCredential = createOwnerScopedGitHubRepositoryCredentialReader({
      environment: input.environment,
      installations: createPostgresHostedGitHubInstallationStore(input.database),
      fetch: input.fetch,
    });
    const github = createCentralHostGitHubProvider({
      assertCurrent: async (invocation, plan) => {
        await authorize(invocation, plan);
        await provider.assertInheritedEnvironment(plan, invocation.signal);
        if (effect !== undefined) {
          await effect.assertCurrent();
        }
      },
      readCredential: (invocation, plan) =>
        githubCredential(invocation, plan.source, () => authorize(invocation, plan)),
      fetch: input.fetch,
    });
    const observer = createCentralHostObservation({
      provider,
      assertCurrent: async (invocation, plan) => {
        await authorize(invocation, plan);
        await history(plan);
      },
      readValues: async (invocation, plan) => {
        const retained = await frozen(invocation, plan);
        return retained.values;
      },
      token: input.readInspectorToken ?? createVercelWorkloadIdentity().token,
      fetch: input.fetch,
    });
    const setupRow = async (plan: CentralHostCallerPlan) => {
      const row = await store.read(plan.setupAuthority, plan.setup.operationRef);
      if (
        row?.record.plan.kind !== "central-integration-host-setup-v1" ||
        row.record.planDigest !== plan.setup.planDigest
      )
        {throw fail();}
      return row;
    };
    const observeCaller = async (invocation: PublicReleaseInvocation, row: CentralHostRow) => {
      if (row.record.plan.kind !== "central-integration-host-caller-v1") {throw fail();}
      const plan = row.record.plan;
      await authorize(invocation, plan);
      await history(plan);
      const setup = await setupRow(plan);
      await history(setup.record.plan);
      if (
        setup.record.plan.kind !== "central-integration-host-setup-v1" ||
        !(await observer(invocationFor(setup.record.plan), setup)) ||
        setup.record.nativeDeployment?.status !== "accepted"
      )
        {return undefined;}
      const grant = await provider.observeCaller(plan, invocation.signal);
      if (grant === undefined) {return undefined;}
      const normal = await input.owner.readStandardDestination({
        authority: plan.authority,
        ownerContext: await ownerFor(plan),
        target: { appId: plan.selection.initiatingAppId, sessionId: plan.selection.sessionId },
      });
      if (
        normal === undefined ||
        normal.projectId !== plan.caller.projectId ||
        normal.teamId !== plan.caller.ownerId ||
        normal.provisioningRequestId !== plan.caller.provisioningRequestId ||
        normal.provisioningDigest !== plan.caller.provisioningDigest
      )
        {throw fail();}
      const source = setup.record.plan;
      return centralHostReadyReceiptSchema.parse({
        version: 1,
        kind: "central-integration-host-ready-v1",
        authority: plan.authority,
        setup: plan.setup,
        callerSetup: { operationRef: row.operationRef, planDigest: row.record.planDigest },
        profile: source.profile,
        resourceProfileId: source.resourceProfileId,
        control: source.control,
        activation: source.activation,
        provider: source.provider,
        deployment: {
          projectId: source.target.projectId,
          teamId: source.target.teamId,
          installationId: source.target.installationId,
          environment: "preview",
          serviceId: "integrations",
          providerDeploymentId: setup.record.nativeDeployment.providerDeploymentId,
          immutableOrigin: setup.record.nativeDeployment.immutableOrigin,
          configurationRef: source.source.configurationRef,
          configurationSha256: source.source.configurationSha256,
        },
        caller: {
          projectId: plan.caller.projectId,
          ownerId: plan.caller.ownerId,
          environment: "production",
          trustedSourcesGrantSha256: grant.trustedSourcesGrantSha256,
        },
      });
    };
    const receiver = (context: CentralHostEffectContext) => {
      if (context.plan.kind !== "central-integration-host-setup-v1") {throw fail();}
      const plan = context.plan;
      return {
        plan,
        signal: context.invocation.signal,
        priorPhase: context.priorPhase,
        readAccepted: async () => {
          const runtime = await frozen(context.invocation, plan);
          const saved = await runtime.custody.read(
            "accepted-receiver",
            plan.receiver.subscriptionRef,
          );
          if (saved === undefined) {return undefined;}
          const accepted = centralAcceptedReceiverSchema.parse(saved.value);
          return { id: accepted.id, secretSha256: accepted.secretSha256 };
        },
        persistAccepted: async (value: { id: string; secret: string; secretSha256: string }) => {
          await context.assertCurrent();
          const retained = await frozen(context.invocation, plan);
          await retained.custody.recordAcceptedReceiver({
            ...value,
            subscriptionRef: plan.receiver.subscriptionRef,
          });
        },
        claimDispatch: context.assertCurrent,
      };
    };
    const bindings = (context: CentralHostEffectContext) => {
      if (context.plan.kind !== "central-integration-host-setup-v1") {throw fail();}
      const plan = context.plan;
      return {
        plan,
        signal: context.invocation.signal,
        priorPhase: context.priorPhase,
        bindings: {
          read: async () => await context.bindings.read(),
          claim: context.bindings.claim,
          recordAccepted: context.bindings.recordAccepted,
          recordVerified: context.bindings.recordVerified,
        },
      };
    };
    const worker = createCentralIntegrationSandboxWorker({
      configuration: input.configuration.sandbox,
      readPrivateFiles: async (context) => {
        if (context.plan.kind !== "central-integration-host-setup-v1") {throw fail();}
        const values = await frozen(context.invocation, context.plan);
        const current = profile();
        return {
          connections: values.connections,
          resourceCredentials: values.resourceCredentials,
          bootstrap: {
            databaseUrl: current.private.bootstrap.connectionString,
            role: current.private.bootstrap.bootstrapRole,
            maintenanceDatabase: current.private.bootstrap.maintenanceDatabase,
          },
        };
      },
    });
    const reconcile: CentralHostServicePorts["reconcileEffect"] = async (context) => {
      effect = context;
      try {
        let receipt: CentralEffectReceipt | undefined;
        switch (context.effect) {
          case "prepare-central-resources":
          case "install-central-schema": {
            return await worker.reconcile(context);
          }
          case "register-deployment-receiver": {
            const observed = await provider.observeReceiver(receiver(context));
            if (observed !== undefined) {receipt = { effect: context.effect, ...observed };}
            break;
          }
          case "authorize-central-inspector":
          case "authorize-app-central-caller": {
            const observed = await provider.observeCaller(context.plan, context.invocation.signal);
            const attempt = await context.checkpoint.read();
            if (
              observed !== undefined &&
              attempt.grantAttempt?.afterSha256 === observed.trustedSourcesSha256
            )
              {receipt = { effect: context.effect, ...observed };}
            break;
          }
          case "bind-central-preview-runtime": {
            const observed = await provider.observeRuntime(bindings(context));
            if (observed !== undefined) {receipt = { effect: context.effect, ...observed };}
            break;
          }
          case "publish-central-host-source": {
            if (context.plan.kind === "central-integration-host-setup-v1")
              receipt = await github.inspect(context.invocation, context.plan);
            break;
          }
        }
        return receipt === undefined ? { status: "unknown" } : { status: "applied", receipt };
      } finally {
        effect = undefined;
      }
    };
    const ports: CentralHostServicePorts = {
      store,
      assertAuthorized: async (invocation, plan) => {
        await authorize(invocation, plan);
        if (plan.kind === "central-integration-host-setup-v1")
          {await provider.assertInheritedEnvironment(plan, invocation.signal);}
      },
      readApproval: approval,
      withTargetLease: createCentralHostTargetLease({
        databaseUrl: input.databaseUrl,
        store,
        assertCurrent: authorize,
      }),
      observeSetup: observer,
      observeCaller,
      resolveReady: async (invocation, desired) => {
        await assertCurrentOwner();
        const normal = await input.owner.readStandardDestination({
          authority: invocation.authority,
          ownerContext,
          target: { appId: desired.appId, sessionId: invocation.sessionId },
        });
        if (normal === undefined)
          {throw new CentralHostPrerequisiteError("central_host_destination_required");}
        const retained = await store.readReadyCaller(invocation.authority, normal.projectId);
        if (retained === undefined) {return undefined;}
        const plan = retained.record.plan;
        const setup = await configuredSetup();
        if (
          plan.kind !== "central-integration-host-caller-v1" ||
          plan.selection.initiatingAppId !== desired.appId ||
          setup === undefined ||
          plan.setup.operationRef !== setup.operationRef ||
          plan.setup.planDigest !== setup.record.planDigest ||
          !isDeepStrictEqual(plan.setupAuthority, setup.record.plan.authority) ||
          plan.caller.ownerId !== normal.teamId ||
          plan.caller.provisioningRequestId !== normal.provisioningRequestId ||
          plan.caller.provisioningDigest !== normal.provisioningDigest
        )
          {throw fail();}
        const observed = await observeCaller(invocationFor(plan), retained);
        await assertCurrentOwner();
        if (observed === undefined || !isDeepStrictEqual(observed, retained.record.observation))
          {throw fail();}
        return observed;
      },
      resolvePlan: async (invocation, desired) => {
        await assertCurrentOwner();
        const current = profile();
        if (!current.owners.some((authority) => isDeepStrictEqual(authority, invocation.authority)))
          {throw fail();}
        const digest = centralIntegrationPrivateProfileDigest(current);
        if (desired.kind === "setup") {
          const retained = await configuredSetup();
          if (
            retained !== undefined &&
            (!isDeepStrictEqual(retained.record.plan.authority, invocation.authority) ||
              retained.record.plan.selection.sessionId !== invocation.sessionId ||
              retained.record.plan.selection.initiatingAppId !== desired.appId)
          ) {
            throw new CentralHostPrerequisiteError("central_host_setup_recovery_required");
          }
        }
        const selection = await createCentralHostPlanSelection({
          database: input.database,
          invocation,
          appId: desired.appId,
          kind: desired.kind,
          profileDigest: digest,
          assertCurrent: assertCurrentOwner,
        });
        if (selection.selected !== undefined) {
          const selected = await store.read(invocation.authority, selection.selected.operationRef);
          if (
            selected === undefined ||
            selected.record.planDigest !== selection.selected.planDigest
          )
            {throw fail();}
          await authorize(invocation, selected.record.plan);
          if (selected.record.plan.kind === "central-integration-host-setup-v1") {
            await captureSource({
              invocation,
              plan: selected.record.plan,
              assertCurrent: assertCurrentOwner,
            });
          }
          return selected.record.plan;
        }
        let plan: Plan;
        if (desired.kind === "setup") {
          if (input.configuration.sandbox.centralIntegrationWorker === undefined)
            {throw new CentralHostPrerequisiteError("central_host_source_required");}
          const values = await resolveCentralRuntimeConfiguration({
            database: input.database,
            keyring: input.keyring,
            profile: current,
            authority: invocation.authority,
            assertCurrent: assertCurrentOwner,
          });
          const { sourceBranch: _branch, ...source } = current.source;
          void _branch;
          const draft = centralHostSetupPlanSchema.parse({
            version: 1,
            kind: "central-integration-host-setup-v1",
            intentId: selection.intentId,
            authority: invocation.authority,
            selection: { sessionId: invocation.sessionId, initiatingAppId: desired.appId },
            profile: { id: current.id, digest },
            resourceProfileId: current.resourceProfileId,
            target: current.target,
            control: current.control,
            provider: current.provider,
            activation: values.activation,
            source: {
              ...source,
              operationBranch: `builder/integrations-host/${selection.intentId}`,
              expectedBranchAbsent: true,
              configurationRef: values.configurationRef,
              configurationSha256: values.configurationSha256,
            },
            environment: values.environment,
            receiver: {
              ...current.receiver,
              subscriptionRef: selection.subscriptionRef,
              path: `/api/central-integrations/deployment-events/${selection.subscriptionRef}`,
              events: ["deployment.created", "deployment.ready"],
            },
            inspector: {
              projectId: current.inspector.projectId,
              environment: current.inspector.environment,
              targetEnvironment: "preview",
              priorGrantSha256: "0".repeat(64),
            },
            effects: [
              "prepare-central-resources",
              "install-central-schema",
              "register-deployment-receiver",
              "authorize-central-inspector",
              "bind-central-preview-runtime",
              "publish-central-host-source",
            ],
          });
          await provider.assertInheritedEnvironment(draft, invocation.signal);
          try {
            if ((await github.inspect(invocation, draft)) !== undefined) {throw fail();}
          } catch {
            await assertCurrentOwner();
            throw new CentralHostPrerequisiteError("central_host_source_required");
          }
          await captureSource({ invocation, plan: draft, assertCurrent: assertCurrentOwner });
          const snapshot = await provider.readTrustedSources(draft, invocation.signal);
          plan = centralHostSetupPlanSchema.parse({
            ...draft,
            inspector: { ...draft.inspector, priorGrantSha256: snapshot.sha256 },
          });
        } else {
          const row = await configuredSetup();
          if (
            row?.record.plan.kind !== "central-integration-host-setup-v1" ||
            row.record.nativeDeployment?.status !== "accepted" ||
            !(await observer(invocationFor(row.record.plan), row))
          )
            {throw new CentralHostPrerequisiteError("central_host_setup_required");}
          const setup = {
            authority: row.record.plan.authority,
            operationRef: row.operationRef,
            planDigest: row.record.planDigest,
          };
          const normal = await input.owner.readStandardDestination({
            authority: invocation.authority,
            ownerContext,
            target: { appId: desired.appId, sessionId: invocation.sessionId },
          });
          if (normal === undefined)
            {throw new CentralHostPrerequisiteError("central_host_destination_required");}
          const draft = centralHostCallerPlanSchema.parse({
            version: 1,
            kind: "central-integration-host-caller-v1",
            authority: invocation.authority,
            selection: { sessionId: invocation.sessionId, initiatingAppId: desired.appId },
            profile: { id: current.id, digest },
            setup: { operationRef: setup.operationRef, planDigest: setup.planDigest },
            setupAuthority: setup.authority,
            central: {
              projectId: current.target.projectId,
              teamId: current.target.teamId,
              installationId: current.target.installationId,
              providerDeploymentId: row.record.nativeDeployment.providerDeploymentId,
              immutableOrigin: row.record.nativeDeployment.immutableOrigin,
              configurationSha256: row.record.plan.source.configurationSha256,
            },
            caller: {
              projectId: normal.projectId,
              ownerId: normal.teamId,
              environment: "production",
              targetEnvironment: "preview",
              provisioningRequestId: normal.provisioningRequestId,
              provisioningDigest: normal.provisioningDigest,
              priorGrantSha256: "0".repeat(64),
            },
            effects: ["authorize-app-central-caller"],
          });
          const snapshot = await provider.readTrustedSources(draft, invocation.signal);
          plan = centralHostCallerPlanSchema.parse({
            ...draft,
            caller: { ...draft.caller, priorGrantSha256: snapshot.sha256 },
          });
        }
        await authorize(invocation, plan);
        await store.reserve(plan);
        await selection.select({
          operationRef: centralHostOperationRef(plan),
          planDigest: centralHostPlanDigest(plan),
        });
        return plan;
      },
      applyEffect: async (context) => {
        effect = context;
        try {
          let receipt: CentralEffectReceipt;
          switch (context.effect) {
            case "prepare-central-resources":
            case "install-central-schema": {
              receipt = await worker.execute(context);
              break;
            }
            case "register-deployment-receiver": {
              receipt = {
                effect: context.effect,
                ...(await provider.registerReceiver(receiver(context))),
              };
              break;
            }
            case "authorize-central-inspector":
            case "authorize-app-central-caller": {
              const attempt = await context.checkpoint.read();
              receipt = {
                effect: context.effect,
                ...(await provider.authorizeCaller({
                  plan: context.plan,
                  signal: context.invocation.signal,
                  priorPhase: context.priorPhase,
                  grantAttempt: attempt.grantAttempt,
                  claimDispatch: context.checkpoint.recordGrantAttempt,
                })),
              };
              break;
            }
            case "bind-central-preview-runtime": {
              await provider.bindRuntime(bindings(context));
              const observed = await provider.observeRuntime(bindings(context));
              if (observed === undefined) {throw fail();}
              receipt = { effect: context.effect, ...observed };
              break;
            }
            case "publish-central-host-source": {
              receipt = await github.publish(context);
              break;
            }
          }
          await context.checkpoint.recordAccepted(receipt);
        } finally {
          effect = undefined;
        }
      },
      reconcileEffect: reconcile,
    };
    return { ports, observeCaller, history, observer, approval };
  };
  const request = createCentralHostDispatcher({
    owner: input.owner,
    createPorts: async ({ request, input: transport, assertCurrentOwner }) =>
      compose(request, transport.ownerContext, assertCurrentOwner).ports,
  });
  const configuredSetup = async () => {
    const current = profile();
    if (current.globalSetup !== undefined) {
      const selected = await store.read(
        current.globalSetup.authority,
        current.globalSetup.operationRef,
      );
      if (selected === undefined || selected.record.planDigest !== current.globalSetup.planDigest)
        {throw fail();}
      return selected;
    }
    return await store.findSetupForProfile(
      current.owners,
      centralIntegrationPrivateProfileDigest(current),
      current.target.projectId,
    );
  };
  const readReady: import("./app-integration-central-authority").ReadCentralIntegrationHostReady =
    async (scope) => {
      if (input.request === undefined) {throw fail();}
      const caller = await store.readReadyCaller(scope.authority, scope.appProjectId);
      if (caller?.record.plan.kind !== "central-integration-host-caller-v1") {return undefined;}
      const owner = await ownerFor(caller.record.plan);
      const current = compose(input.request, owner, scope.assertCurrentOwner);
      return await createReadCentralIntegrationHostReady({
        store,
        assertSetupAuthorized: async (_scope, setup) => await current.history(setup.record.plan),
        observe: async (_scope, selected) => {
          const observed = await current.observeCaller(
            {
              authority: selected.record.plan.authority,
              sessionId: selected.record.plan.selection.sessionId,
              callId: "historical-read",
              signal: scope.signal,
            },
            selected,
          );
          if (observed === undefined) {throw fail();}
          return observed;
        },
      })(scope);
    };
  const privateReady = async (
    receipt: import("./app-integration-central-authority").CentralIntegrationHostReadyReceipt,
    assertCurrent: () => Promise<void>,
  ) => {
    await assertCurrent();
    if (input.request === undefined) {throw fail();}
    const caller = await store.read(receipt.authority, receipt.callerSetup.operationRef);
    if (
      caller?.record.plan.kind !== "central-integration-host-caller-v1" ||
      caller.record.planDigest !== receipt.callerSetup.planDigest ||
      !isDeepStrictEqual(caller.record.plan.setup, receipt.setup)
    )
      {throw fail();}
    const observed = await readReady({
      authority: receipt.authority,
      appId: caller.record.plan.selection.initiatingAppId,
      appProjectId: receipt.caller.projectId,
      teamId: receipt.caller.ownerId,
      assertCurrentOwner: assertCurrent,
      signal: input.request.signal,
    });
    if (observed === undefined || !isDeepStrictEqual(observed, receipt)) {throw fail();}
    const setup = await store.read(caller.record.plan.setupAuthority, receipt.setup.operationRef);
    if (
      setup?.record.plan.kind !== "central-integration-host-setup-v1" ||
      setup.record.planDigest !== receipt.setup.planDigest
    )
      {throw fail();}
    const values = await frozen(
      {
        authority: setup.record.plan.authority,
        sessionId: setup.record.plan.selection.sessionId,
        callId: "historical-read",
        signal: input.request.signal,
      },
      setup.record.plan,
    );
    await assertCurrent();
    return values;
  };
  const readPrivate = async (
    receipt: import("./app-integration-central-authority").CentralIntegrationHostReadyReceipt,
    assertCurrent: () => Promise<void>,
  ): Promise<AppIntegrationCentralPrivateValues> => {
    const values = await privateReady(receipt, assertCurrent);
    return {
      controlMigratorUrl: values.connections.migrator,
      ...(values.values.INTEGRATIONS_AMPERSAND_API_KEY === undefined
        ? {}
        : { providerApiKey: values.values.INTEGRATIONS_AMPERSAND_API_KEY }),
      productionControlDatabaseIdentity: profile().private.bootstrap.productionDatabaseIdentity,
      authorityKeyring: centralIntegrationPrivateSeedSchema.shape.authorityKeyring.parse(
        JSON.parse(values.values.INTEGRATIONS_APPLICATION_AUTHORITY_KEYRING ?? "null"),
      ),
    };
  };
  const readControlBootstrap: NonNullable<
    Parameters<
      typeof import("./app-integration-capability-deployment").createAppIntegrationCapabilityDeployment
    >[0]["readControlBootstrap"]
  > = async (plan, assertCurrent) => {
    await assertCurrent();
    const current = profile();
    if (
      plan.control.resourceProfileId !== current.resourceProfileId ||
      !isDeepStrictEqual(plan.control.neon, current.control.neon) ||
      plan.control.database.database !== current.control.resource.database ||
      plan.control.database.migratorRole !== current.control.resource.migratorRole
    )
      {throw fail();}
    return {
      databaseUrl: current.private.bootstrap.connectionString,
      role: current.private.bootstrap.bootstrapRole,
      maintenanceDatabase: current.private.bootstrap.maintenanceDatabase,
    };
  };
  const receive = async (received: Request): Promise<Response> => {
    const reply = (code: string, status = 200) =>
      Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
    const url = new URL(received.url);
    const match = /^\/api\/central-integrations\/deployment-events\/([a-f0-9-]{36})$/u.exec(
      url.pathname,
    );
    if (received.method !== "POST" || match === null || url.search) {return reply("not_found", 404);}
    try {
      const subscriptionRef = z.uuid().parse(match[1]);
      const current = profile();
      let row = await store.readSetupForSubscription(current.owners, subscriptionRef);
      if (
        row?.record.plan.kind !== "central-integration-host-setup-v1" ||
        row.record.nativeDeployment === undefined
      )
        {throw fail();}
      const plan = row.record.plan;
      if (
        !["pending", "applied"].includes(
          row.record.effects["publish-central-host-source"] ?? "idle",
        )
      )
        {throw fail();}
      const invocation = {
        authority: plan.authority,
        sessionId: plan.selection.sessionId,
        callId: "signed-receipt",
        signal: received.signal,
      };
      const values = await frozen(invocation, plan);
      const secret = await values.custody.read("accepted-receiver", subscriptionRef);
      if (secret === undefined) {throw fail();}
      const accepted = centralAcceptedReceiverSchema.parse(secret.value);
      const reader = received.body?.getReader();
      if (reader === undefined) {throw fail();}
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) {break;}
          length += part.value.length;
          if (length > 262_144) {throw fail();}
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const receipt = verifyCentralNativeDeploymentReceipt({
        plan,
        raw: Buffer.concat(chunks),
        signature: received.headers.get("x-vercel-signature") ?? "",
        secret: accepted.secret,
      });
      if (receipt === undefined) {return reply("ignored");}
      for (;;) {
        await authorize(invocation, plan);
        if (row.record.nativeDeployment === undefined || !isDeepStrictEqual(row.record.plan, plan))
          {throw fail();}
        const state = retainCentralNativeDeploymentReceipt(row.record.nativeDeployment, receipt);
        if (isDeepStrictEqual(state, row.record.nativeDeployment))
          {return reply(
            state.status === "conflict" ? "conflict" : "accepted",
            state.status === "conflict" ? 409 : 200,
          );}
        const changed = await store.compareAndSet(row, { ...row.record, nativeDeployment: state });
        if (changed !== undefined)
          {return reply(
            state.status === "conflict" ? "conflict" : "accepted",
            state.status === "conflict" ? 409 : 200,
          );}
        const observed = await store.read(plan.authority, row.operationRef);
        if (observed === undefined) {throw fail();}
        row = observed;
      }
    } catch {
      return reply("central_deployment_receipt_rejected", 403);
    }
  };
  return {
    request,
    store,
    compose,
    frozen,
    profile,
    readReady,
    readPrivate,
    readControlBootstrap,
    configuredSetup,
    receive,
  };
};
