/* oxlint-disable eslint/complexity, sonarjs/expression-complexity, unicorn/no-useless-undefined -- The retained infrastructure prerequisite keeps every owner, resource and native transport identity comparison together. */
import { isDeepStrictEqual } from "node:util";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  nativeDeliveryGitRef,
  retainedOperatorAuthSchema,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import { retainedOperatorAuthFromJournal } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRecord, HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";

type Configuration = Pick<
  HostedOperatorSourceConfiguration,
  "teamId" | "authDatabase" | "builderCallbackOrigin" | "gateway" | "operator" | "workloadPolicy"
> & {
  nativeNeon: {
    scope: HostedOperatorSourceConfiguration["nativeNeon"]["scope"];
    configuration: Pick<
      HostedOperatorSourceConfiguration["nativeNeon"]["configuration"],
      "operator"
    >;
  };
};

export const configuredBootstrapGatewayBindings = (
  configuration: Configuration,
): NonNullable<HostedOperatorPlan["gatewayBindings"]> => {
  const { workloadPolicy: builder } = configuration;
  const { operator } = configuration.nativeNeon.configuration;
  return {
    authBrowserOrigin: configuration.gateway.authBrowserOrigin,
    builderCallbackOrigin: configuration.builderCallbackOrigin,
    catalogAppIds: configuration.gateway.protectedApplicationIds,
    operatorOrigin: configuration.operator.origin,
    readonlyAttesters:
      builder.environment === "production" && operator.environment === "preview"
        ? {
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
          }
        : undefined,
    sourceWorkload: {
      ...configuration.gateway.workload,
      environment: configuration.gateway.environment,
    },
  };
};

export const infrastructureOnly = (plan: HostedOperatorPlan) =>
  plan.action === "prepare" &&
  plan.stage === "auth-bootstrap" &&
  plan.access.length === 0 &&
  plan.authMembership === undefined &&
  plan.normalActorPreparation === undefined &&
  plan.delivery === undefined &&
  plan.authSignupPolicy === undefined &&
  plan.effects.every(
    (effect) =>
      (effect.kind === "resources" &&
        [plan.authDatabase.resourceId, plan.appDatabase.resourceId].includes(
          effect.resourceId ?? "",
        )) ||
      (effect.kind === "install" && effect.id === "auth-schema") ||
      effect.kind === "gateway-bindings" ||
      effect.kind === "gateway-delivery",
  );

/** Owned infrastructure prerequisite, never an app release selection or authority to reuse its approval. */
export const createExistingAuthBootstrapPrerequisite = (
  record: HostedRuntimeJournalRecord | undefined,
  context: HostedOperatorContext & {
    normalActorProgram?: HostedOperatorPlan["normalActorProgram"];
  },
  configuration: Configuration,
  appDatabase: HostedOperatorPlan["appDatabase"],
  now: number,
  gatewaySource?: NonNullable<HostedOperatorPlan["gatewayDelivery"]>,
) => {
  const current = record?.operator;
  const parsed = retainedOperatorAuthSchema.safeParse(
    record === undefined
      ? undefined
      : (record.retainedAuth ?? retainedOperatorAuthFromJournal(record)),
  );
  if (record?.privateState === undefined || current === undefined || !parsed.success) {
    return undefined;
  }
  const auth = parsed.data;
  const prior = auth.plan;
  const boundary = prior.deploymentBoundary;
  const native = configuration.nativeNeon.scope;
  if (
    !infrastructureOnly(prior) ||
    boundary === undefined ||
    prior.gatewayBindings === undefined ||
    prior.gatewayDelivery === undefined ||
    prior.publicGateway === undefined
  ) {
    return undefined;
  }
  const selection = {
    appId: context.target.appId,
    branch: context.target.branch,
    environment: context.target.environment,
    projectId: context.target.projectId,
    sessionId: context.target.sessionId,
  };
  const program =
    context.normalActorProgram ??
    record.accountPreparation?.program ??
    current.plan.normalActorProgram ??
    prior.normalActorProgram;
  const same = [
    isDeepStrictEqual(record.request, context.target),
    sameOperatorSelection(prior.selection, selection),
    sameOperatorSelection(current.plan.selection, selection),
    isDeepStrictEqual(boundary.authority, context.authority),
    boundary.teamId === configuration.teamId,
    context.target.scopeId === configuration.teamId,
    context.target.environment === "preview",
    isDeepStrictEqual(prior.appDatabase, appDatabase),
    isDeepStrictEqual(current.plan.appDatabase, prior.appDatabase),
    isDeepStrictEqual(prior.authDatabase, configuration.authDatabase),
    isDeepStrictEqual(current.plan.authDatabase, prior.authDatabase),
    isDeepStrictEqual(current.plan.neon, prior.neon),
    prior.neon.projectId === native.projectId,
    prior.neon.branchId === native.branchId,
    prior.neon.endpoint === native.hostname,
    prior.bootstrap?.endpointId === native.endpointId,
    prior.bootstrap?.maintenanceDatabase === native.maintenanceDatabase,
    prior.bootstrap?.role === native.maintenanceRole,
    isDeepStrictEqual(current.plan.bootstrap, prior.bootstrap),
    current.plan.authSchema?.targetDigest === auth.authPreparation.targetDigest,
    current.authPreparation?.database === auth.authPreparation.database,
    current.authPreparation?.runtimeRole === auth.authPreparation.runtimeRole,
    current.authPreparation?.targetDigest === auth.authPreparation.targetDigest,
    prior.gatewayDelivery.projectId === configuration.gateway.projectId,
    prior.gatewayDelivery.branch === configuration.gateway.branch,
    prior.gatewayDelivery.repoId === configuration.gateway.repoId,
    prior.publicGateway.projectId === configuration.gateway.projectId,
    prior.publicGateway.branch === configuration.gateway.branch,
    prior.publicGateway.origin === configuration.gateway.publicOrigin,
    boundary.gateway.projectId === configuration.gateway.projectId,
    boundary.gateway.branch === configuration.gateway.branch,
    boundary.verification.publicOrigin === configuration.gateway.publicOrigin,
    boundary.operator.projectId === configuration.operator.projectId,
    boundary.operator.environment === configuration.operator.environment,
    prior.gatewayBindings.authBrowserOrigin === configuration.gateway.authBrowserOrigin,
    prior.gatewayBindings.builderCallbackOrigin === configuration.builderCallbackOrigin,
    prior.gatewayBindings.operatorOrigin === configuration.operator.origin,
    program === undefined ||
      prior.normalActorProgram === undefined ||
      normalActorProgramDigest(program) === normalActorProgramDigest(prior.normalActorProgram),
    record.accountPreparation === undefined ||
      (program !== undefined &&
        record.accountPreparation.programDigest === normalActorProgramDigest(program)),
  ];
  if (!same.every(Boolean)) {
    return undefined;
  }
  const gatewayBindings = configuredBootstrapGatewayBindings(configuration);
  const gatewayDelivery = gatewaySource ?? {
    branch: configuration.gateway.branch,
    gitSha: configuration.gateway.gitSha,
    projectId: configuration.gateway.projectId,
    repoId: configuration.gateway.repoId,
  };
  const currentMatches =
    isDeepStrictEqual(
      {
        ...current.plan.gatewayBindings,
        readonlyAttesters: current.plan.gatewayBindings?.readonlyAttesters,
      },
      { ...gatewayBindings, readonlyAttesters: gatewayBindings.readonlyAttesters },
    ) &&
    isDeepStrictEqual(
      {
        ...current.plan.gatewayDelivery,
        gitRef:
          current.plan.gatewayDelivery === undefined
            ? undefined
            : nativeDeliveryGitRef(current.plan, current.plan.gatewayDelivery, "gateway"),
      },
      { ...gatewayDelivery, gitRef: gatewayDelivery.gitRef ?? gatewayDelivery.branch },
    );
  if (currentMatches) {
    return infrastructureOnly(current.plan) &&
      current.plan.effects.some(
        (effect) => !current.receipts.some((receipt) => receipt.effectId === effect.id),
      )
      ? { auth, plan: current.plan }
      : undefined;
  }
  if (
    record.leaseId !== undefined ||
    record.leaseExpiresAt !== undefined ||
    current.pendingEffectId !== undefined ||
    current.pendingEffectAttempt !== undefined
  ) {
    return undefined;
  }
  const plan = hostedOperatorPlanSchema.parse({
    ...prior,
    normalActorProgram: program,
    gatewayBindings,
    gatewayDelivery,
    cost: {
      ...prior.cost,
      description:
        "Refresh existing Auth and Gateway infrastructure only. Historical app release metadata does not validate or publish the current app revision.",
    },
    retention: { ...prior.retention, expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString() },
  });
  return { auth, plan };
};

/** Re-read both current ownership and the original completed Auth approval; no old approval approves this new plan. */
export const readExistingAuthBootstrapPrerequisite = async (
  current: HostedRuntimeJournalRow | undefined,
  context: HostedOperatorContext & {
    normalActorProgram?: HostedOperatorPlan["normalActorProgram"];
  },
  configuration: Configuration,
  appDatabase: HostedOperatorPlan["appDatabase"],
  ports: {
    assertPlanningAuthorized: (context: HostedOperatorContext) => Promise<void>;
    readApproval: ProtectedHostedOperatorDependencies["readApproval"];
    store: Pick<ProtectedHostedOperatorDependencies["store"], "read">;
  },
  now: number,
  gatewaySource?: NonNullable<HostedOperatorPlan["gatewayDelivery"]>,
) => {
  const proposed = createExistingAuthBootstrapPrerequisite(
    current?.record,
    context,
    configuration,
    appDatabase,
    now,
    gatewaySource,
  );
  if (proposed === undefined) {
    return undefined;
  }
  await ports.assertPlanningAuthorized(context);
  const { auth } = proposed;
  const approval = await ports.readApproval({
    ...context,
    action: "prepare",
    callId: auth.approvedByCallId,
    planDigest: auth.planDigest,
  });
  const approved = [
    approval?.approved,
    approval?.approvalId === auth.approvalId,
    approval?.callId === auth.approvedByCallId,
    approval?.planDigest === auth.planDigest,
    approval?.action === "prepare",
  ].every(Boolean);
  if (!approved) {
    throw new HostedOperatorError("authorization_required");
  }
  const latest = await ports.store.read(context);
  if (latest?.revision !== current?.revision) {
    throw new HostedOperatorError("operation_in_progress");
  }
  await ports.assertPlanningAuthorized(context);
  return proposed.plan;
};
