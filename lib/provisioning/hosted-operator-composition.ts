import { hasFailedGatewayDelivery } from "./hosted-operator-gateway-delivery-failure";
import { inspectParticipantBootstrapPreparation } from "./hosted-operator-participant-bootstrap";
import { createHostedOperatorConsentOwner } from "./hosted-operator-consent-owner";
import {
  createHostedOperatorNeonAuthorization,
  readNeonAuthorizationConfiguration,
  neonAuthorizationConfigurationSchema,
} from "./hosted-operator-neon-authorization";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
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
  operatorSelectionSchema,
} from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  HostedOperatorAuthSignupPolicy,
  HostedOperatorAuthSignupPolicyInput,
  ManagedOperatorEnvironmentRow,
  OperatorDeploymentCandidate,
  HostedOperatorOwnedOrganizationSpec,
} from "./hosted-operator-contract";
import {
  assertNormalActorState,
  normalActorProgramDigest,
  proposeResolvedNormalActorAccess,
  resolvedNormalActorAccess,
} from "./hosted-operator-normal-actor-program";
import type { NormalActorProgram, NormalActorState } from "./hosted-operator-normal-actor-program";
import type { NormalActorAccountPreparation } from "./hosted-operator-normal-actor-journal";
import type {
  HostedOperatorContext,
  HostedOperatorEffectContext,
  HostedOperatorWorkerEffectContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { openHostedOperatorCompositionResources } from "./hosted-operator-source-configuration";
import {
  reportOperatorPlanningMismatch,
  observeOperatorPlanStage,
} from "./hosted-operator-consent-diagnostic";
import type { OperatorPlanStage } from "./hosted-operator-consent-diagnostic";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
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
import { createHostedOperatorPublicGateway } from "./hosted-operator-public-gateway";
import { resolvePublishedAppDelivery } from "./hosted-operator-published-app-delivery";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import { createHostedOperatorEnvironmentBindings } from "./hosted-operator-environment-bindings";
import { createHostedOperatorAppReadiness } from "./hosted-operator-app-readiness";

const GATEWAY_DELIVERY = "gateway-delivery";
const GATEWAY_BINDINGS = "gateway-bindings";
const AUTH_SCHEMA_EFFECT = "auth-schema";
const RESOURCE_MISMATCH = "resource_mismatch";
const AUTH_MEMBERSHIP_REQUIRED = "auth_membership_required";
const AUTH_MEMBERSHIP = "auth-membership";
const AUTH_SIGNUP_POLICY = "auth-signup-policy";
const OPERATION_IN_PROGRESS = "operation_in_progress";
const RECONCILIATION_REQUIRED = "reconciliation_required";
const bindSignupPolicy = (
  policy: HostedOperatorAuthSignupPolicyInput,
  plan: HostedOperatorPlan,
  organizationId: string | undefined,
  allowedAppRoles: readonly string[],
): HostedOperatorAuthSignupPolicy => {
  const publicOrigin = plan.deploymentBoundary?.verification.publicOrigin;
  const allowedAppRoleSet = new Set(allowedAppRoles);
  if (
    organizationId === undefined ||
    organizationId !== policy.organizationId ||
    publicOrigin === undefined ||
    policy.appRoles.some(
      (role) =>
        !allowedAppRoleSet.has(role) ||
        /(?:^|[_-])(?:owner|admin|administrator)(?:[_-]|$)/u.test(role),
    )
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return {
    ...policy,
    policyId: `${plan.selection.appId}:${organizationId}:signup`,
    authResourceId: plan.authDatabase.resourceId,
    appId: plan.selection.appId,
    origin: publicOrigin,
  };
};
type ControlPlane = Awaited<ReturnType<typeof createHostedOperatorControlPlane>> &
  HostedOperatorNormalActorPorts & {
    readNormalActorRuntimeBindings: NonNullable<
      ProtectedHostedOperatorDependencies["normalActorRuntimeBindings"]
    >;
  };
export interface HostedOperatorNormalActorPlanningPorts {
  readNormalActorPreparation: (context: HostedOperatorContext) => Promise<
    | {
        preparation: NormalActorAccountPreparation;
        state: NormalActorState;
      }
    | undefined
  >;
  readNormalActorOrganizationProofs: (
    input: HostedOperatorContext & {
      plan: HostedOperatorPlan;
      preparation: NormalActorAccountPreparation;
      state: NormalActorState;
    },
  ) => Promise<HostedOperatorOwnedOrganizationSpec[]>;
}
export interface HostedOperatorNormalActorPorts extends HostedOperatorNormalActorPlanningPorts {
  ensureNormalActorCapture: NonNullable<
    ProtectedHostedOperatorDependencies["ensureNormalActorCapture"]
  >;
  normalActorAuthIdentityInput: NonNullable<
    ProtectedHostedOperatorDependencies["authIdentityInput"]
  >;
  prepareNormalActorAccounts: (
    input: HostedOperatorWorkerEffectContext,
  ) => Promise<NormalActorState>;
  verifyNormalActorAccounts: NonNullable<
    ProtectedHostedOperatorDependencies["verifyNormalActorAccounts"]
  >;
  prepareNormalActorMemberships: (
    input: HostedOperatorWorkerEffectContext,
  ) => Promise<NormalActorState>;
  verifyNormalActorMemberships: (input: HostedOperatorEffectContext) => Promise<NormalActorState>;
  reconcileNormalActorMemberships: (
    input: HostedOperatorEffectContext,
  ) => Promise<{ status: "absent" | "applied" | "unknown" }>;
}
const normalActorFingerprint = (state: NormalActorState) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        actors: state.actors.map((actor) => ({
          actorKey: actor.actorKey,
          signup: actor.signup,
          session: actor.session,
        })),
        organizations: state.organizations,
        memberships: state.memberships,
      }),
    )
    .digest("hex");
const canonicalParticipantAccess = (access: HostedOperatorPlan["access"]) =>
  access
    .map((grant) => ({
      actorId: grant.actorId,
      organizationId: grant.organizationId,
      roles: grant.roles.toSorted(),
    }))
    .toSorted((left, right) =>
      `${left.organizationId}:${left.actorId}`.localeCompare(
        `${right.organizationId}:${right.actorId}`,
      ),
    );
const assertParticipantAccess = (plan: HostedOperatorPlan, stateInput: NormalActorState) => {
  const program = plan.normalActorProgram;
  const preparation = plan.normalActorPreparation;
  if (program === undefined || preparation === undefined) {
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  const state = assertNormalActorState(program, stateInput, preparation.accountOperationRef);
  if (
    JSON.stringify(canonicalParticipantAccess(resolvedNormalActorAccess(program, state))) !==
    JSON.stringify(canonicalParticipantAccess(plan.access))
  ) {
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  return state;
};
const assertParticipantOrganization = (
  input: HostedOperatorEffectContext,
  stateInput: NormalActorState,
) => {
  const program = input.plan.normalActorProgram;
  const preparation = input.plan.normalActorPreparation;
  const organization = program?.organizations.find(
    (candidate) => input.effect.id === `auth-membership:${candidate.organizationId}`,
  );
  if (program === undefined || preparation === undefined || organization === undefined) {
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  const state = assertNormalActorState(program, stateInput, preparation.accountOperationRef);
  if (
    !state.organizations.some(
      (candidate) =>
        candidate.organizationId === organization.organizationId && candidate.status === "complete",
    ) ||
    state.memberships.some(
      (membership) =>
        membership.organizationId === organization.organizationId &&
        membership.status !== "complete",
    )
  ) {
    throw new HostedOperatorError(RECONCILIATION_REQUIRED);
  }
  return state;
};
const assertParticipantSignupPolicyState = (
  input: HostedOperatorEffectContext,
  stateInput: NormalActorState,
) => {
  const program = input.plan.normalActorProgram;
  const preparation = input.plan.normalActorPreparation;
  const organizationId = input.plan.authSignupPolicy?.organizationId;
  if (
    program === undefined ||
    preparation === undefined ||
    organizationId === undefined ||
    program.organizations.filter((candidate) => candidate.organizationId === organizationId)
      .length !== 1
  ) {
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  const state = assertNormalActorState(program, stateInput, preparation.accountOperationRef);
  if (
    !state.organizations.some(
      (candidate) => candidate.organizationId === organizationId && candidate.status === "complete",
    ) ||
    state.memberships.some(
      (membership) =>
        membership.organizationId === organizationId && membership.status !== "complete",
    )
  ) {
    throw new HostedOperatorError(RECONCILIATION_REQUIRED);
  }
  return state;
};
const hash = (
  value: ManagedOperatorEnvironmentRow[] | OperatorDeploymentCandidate | { rows: never[] },
) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const selectedApplication = (
  configuration: Pick<HostedOperatorSourceConfiguration, "applications" | "teamId">,
  context: HostedOperatorContext,
) => {
  const selected = configuration.applications[context.target.appId];
  if (selected === undefined) {
    reportOperatorPlanningMismatch(context.target.sessionId, "application_selection", {
      application_missing: true,
    });
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  const failed = {
    app_project: selected.projectId !== context.target.projectId,
    app_branch: selected.branch !== context.target.branch,
    team: context.target.scopeId !== configuration.teamId,
  };
  if (Object.values(failed).some(Boolean)) {
    reportOperatorPlanningMismatch(context.target.sessionId, "application_selection", failed);
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
  return selected;
};

/** Resolve configured metadata under the same live owner/provider authority used by planning. */
export const createConfiguredPreviewTargetResolver =
  (
    configuration: Pick<HostedOperatorSourceConfiguration, "applications" | "teamId">,
    consentOwner: Pick<ReturnType<typeof createHostedOperatorConsentOwner>, "authorize">,
    controlPlane: Pick<ControlPlane, "authorize" | "assertPlanningAuthorized">,
  ): NonNullable<ProtectedHostedOperatorDependencies["resolvePreviewTarget"]> =>
  async (request, identity, ownerContext) => {
    const currentOwner = await consentOwner.authorize(request, identity.sessionId, ownerContext);
    const application = configuration.applications[identity.appId];
    if (application === undefined) {
      throw new HostedOperatorError(RESOURCE_MISMATCH);
    }
    const selection = operatorSelectionSchema.parse({
      appId: identity.appId,
      branch: application.branch,
      environment: "preview",
      projectId: application.projectId,
      sessionId: identity.sessionId,
    });
    const context = await controlPlane.authorize(request, selection, currentOwner.ownerContext);
    selectedApplication(configuration, context);
    await controlPlane.assertPlanningAuthorized(context);
    return context;
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
const assertParticipantOrganizationProposal = (
  program: NormalActorProgram,
  state: NormalActorState,
  organizations: HostedOperatorOwnedOrganizationSpec[],
): void => {
  const complete =
    organizations.length === program.organizations.length &&
    organizations.every((organization) => {
      const selected = program.organizations.find(
        (candidate) => candidate.organizationId === organization.organizationId,
      );
      const owner = state.actors.find(
        (actor) => actor.actorKey === selected?.ownerActorKey,
      )?.session;
      return [
        selected !== undefined,
        owner !== undefined,
        organization.actorId === owner?.actorId,
        organization.identityCapture.realmSessionId === owner?.realmSessionId,
        organization.name === selected?.name,
        organization.slug === selected?.slug,
      ].every(Boolean);
    });
  if (!complete) {
    throw new HostedOperatorError(RESOURCE_MISMATCH);
  }
};
const resolveParticipantPlan = async (
  base: HostedOperatorPlan,
  program: NormalActorProgram,
  signupPolicy: HostedOperatorAuthSignupPolicyInput | undefined,
  context: HostedOperatorContext,
  configuration: HostedOperatorSourceConfiguration,
  controlPlane: Pick<ControlPlane, "assertPlanningAuthorized"> &
    Partial<HostedOperatorNormalActorPlanningPorts>,
  participantsBootstrapPrepared: boolean,
  participantsCompleted: boolean,
  selectedRelease?: CompiledOperatorReleaseSelection,
): Promise<HostedOperatorPlan> => {
  if (!participantsBootstrapPrepared) {
    return base;
  }
  if (controlPlane.readNormalActorPreparation === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  await controlPlane.assertPlanningAuthorized(context);
  const prepared = await controlPlane.readNormalActorPreparation(context);
  if (
    prepared !== undefined &&
    (prepared.preparation.accountsCompletedAt === undefined || !participantsCompleted)
  ) {
    if (prepared.preparation.programDigest !== normalActorProgramDigest(program)) {
      throw new HostedOperatorError("resource_mismatch");
    }
    // Retry the first frozen account plan; a new operation cannot replace its approval or AAD.
    return prepared.preparation.accountPlan;
  }
  if (prepared === undefined) {
    return hostedOperatorPlanSchema.parse({
      ...base,
      stage: "auth-participants",
      effects: [
        {
          id: "normal-accounts",
          kind: "normal-accounts",
          description:
            "Prepare only the approved participants through ordinary signup, sign-in, or normal session capture; persist private state before account effects.",
        },
      ],
    });
  }
  const { preparation } = prepared;
  if (normalActorProgramDigest(program) !== preparation.programDigest) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const state = assertNormalActorState(program, prepared.state, preparation.accountOperationRef);
  if (controlPlane.readNormalActorOrganizationProofs === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  const application = selectedApplication(configuration, context);
  const delivery = resolvePublishedAppDelivery(application, selectedRelease);
  const organizations = await controlPlane.readNormalActorOrganizationProofs({
    ...context,
    plan: base,
    preparation,
    state,
  });
  assertParticipantOrganizationProposal(program, state, organizations);
  const effects: HostedOperatorPlan["effects"] = [
    ...base.effects.filter((effect) => ![GATEWAY_BINDINGS, GATEWAY_DELIVERY].includes(effect.kind)),
    {
      id: "app-install",
      kind: "install",
      description:
        "Install and independently observe the exact compiled app release and protected runtime scope.",
    },
    ...organizations.map<HostedOperatorPlan["effects"][number]>((organization) => ({
      id: `auth-membership:${organization.organizationId}`,
      kind: AUTH_MEMBERSHIP,
      description:
        "Prepare this approved organization, ordinary invitations and actual memberships for its normally authenticated participants.",
    })),
    ...(signupPolicy === undefined
      ? []
      : [
          {
            id: AUTH_SIGNUP_POLICY,
            kind: "auth-signup-policy" as const,
            description:
              "Persist the approved public signup eligibility and app-scoped member roles before the Preview is offered.",
          },
        ]),
    {
      id: "access",
      kind: "access",
      description:
        "Grant only the resolved approved actors, organizations and app roles after fresh normal session and membership readback.",
    },
    {
      id: "bindings",
      kind: "bindings",
      description: "Bind app-owned runtime URL and public verification context.",
    },
    {
      id: "delivery",
      kind: "delivery",
      description:
        "Deliver and pin an independently READY native Preview under the exact approval.",
    },
    ...base.effects.filter((effect) => [GATEWAY_BINDINGS, GATEWAY_DELIVERY].includes(effect.kind)),
  ];
  await controlPlane.assertPlanningAuthorized(context);
  return hostedOperatorPlanSchema.parse({
    ...base,
    ...(signupPolicy === undefined
      ? {}
      : {
          authSignupPolicy: bindSignupPolicy(
            signupPolicy,
            base,
            signupPolicy.organizationId,
            application.accessRoles,
          ),
        }),
    stage: "app",
    access: proposeResolvedNormalActorAccess(program, state),
    authMembership:
      organizations.length === 0
        ? undefined
        : { kind: "create-owned-organizations", organizations },
    normalActorPreparation: {
      accountOperationRef: preparation.accountOperationRef,
      programDigest: preparation.programDigest,
      accountPlanDigest: preparation.accountPlanDigest,
      accountApprovalId: preparation.accountApprovalId,
      accountApprovedByCallId: preparation.accountApprovedByCallId,
    },
    delivery,
    deploymentBoundary:
      base.deploymentBoundary === undefined
        ? undefined
        : {
            ...base.deploymentBoundary,
            app: { ...base.deploymentBoundary.app, branch: delivery.branch },
          },
    effects,
  });
};

export const resolveFullPlan = async (
  base: HostedOperatorPlan,
  context: HostedOperatorContext,
  configuration: HostedOperatorSourceConfiguration,
  controlPlane: Pick<
    ControlPlane,
    "assertPlanningAuthorized" | "readCapturedRealmIdentity" | "readCapturedRealmIdentityProof"
  > &
    Partial<HostedOperatorNormalActorPlanningPorts>,
  transportIo: Parameters<typeof createHostedOperatorRealmHttpTransport>[2] = {},
  participantsBootstrapPrepared = false,
  participantsCompleted = false,
  selectedRelease?: CompiledOperatorReleaseSelection,
  signupPolicy?: HostedOperatorAuthSignupPolicyInput,
): Promise<HostedOperatorPlan> => {
  if (base.normalActorProgram !== undefined) {
    return await resolveParticipantPlan(
      base,
      base.normalActorProgram,
      signupPolicy,
      context,
      configuration,
      controlPlane,
      participantsBootstrapPrepared,
      participantsCompleted,
      selectedRelease,
    );
  }

  const captured = await controlPlane.readCapturedRealmIdentity(context);
  if (captured === null) {
    return base;
  }
  const application = selectedApplication(configuration, context);
  // Bootstrap prepares owned Auth and database resources before app publication.
  // Only the app delivery plan needs the actual published Git source.
  const delivery = resolvePublishedAppDelivery(application, selectedRelease);
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
      kind: AUTH_MEMBERSHIP,
    });
  }
  if (signupPolicy !== undefined) {
    effects.push({
      id: AUTH_SIGNUP_POLICY,
      kind: AUTH_SIGNUP_POLICY,
      description:
        "Persist the approved public signup eligibility and app-scoped member roles before the Preview is offered.",
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
    ...(signupPolicy === undefined
      ? {}
      : {
          authSignupPolicy: bindSignupPolicy(
            signupPolicy,
            base,
            organizationId,
            application.accessRoles,
          ),
        }),
    access: [
      { actorId: verified.identity.actorId, organizationId, roles: application.accessRoles },
    ],
    authMembership,
    delivery,
    deploymentBoundary:
      base.deploymentBoundary === undefined
        ? undefined
        : {
            ...base.deploymentBoundary,
            app: { ...base.deploymentBoundary.app, branch: delivery.branch },
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
  const consentOwner = createHostedOperatorConsentOwner(configuration.workloadPolicy);
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
    assertCanonicalOwner: controlPlane.assertCanonicalOwner,
    readAuthRuntimeUrl: async (input) => {
      const observed = await privateBindings(input);
      return observed.authDatabase.runtimeUrl;
    },
    readCanonicalGatewayRows: async (input) => {
      const source = selectedApplication(configuration, input).authAdoptionSource;
      return await controlPlane.readSharedGatewayRows({ effect: input, source });
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

  // oxlint-disable-next-line eslint/complexity -- Keep cleanup, fresh Auth, and shared adoption plans at the same authority boundary.
  const plan = async (
    context: HostedOperatorContext & {
      action: "prepare" | "cleanup";
      normalActorProgram?: NormalActorProgram;
      authSignupPolicy?: HostedOperatorAuthSignupPolicyInput;
    },
  ): Promise<HostedOperatorPlan> => {
    const observe = async <T>(stage: OperatorPlanStage, run: () => T | Promise<T>) =>
      await observeOperatorPlanStage(context.target.sessionId, stage, run);
    const application = selectedApplication(configuration, context);
    const current = await observe(
      "journal_read",
      async () => await controlPlane.store.read(context),
    );
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
    const selected = await observe(
      "accepted_spec",
      async () => await readOwnedOperatorPlanningSelection({ context, controlPlane }),
    );
    const selection = await observe("release_selection", () => {
      if (selected.selection === undefined) {
        throw new HostedOperatorError("operator_unavailable");
      }
      return selected.selection;
    });
    await observe(
      "release_read",
      async () => await controlPlane.readGeneratedRelease(context, selection),
    );
    await observe("neon_planning", async () => {
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
    });
    const inventory = await observe(
      "provider_inventory",
      async () =>
        await readHostedOperatorProviderInventory({
          assertCurrentOwner: async () => {
            await controlPlane.assertPlanningAuthorized(context);
          },
          configuration: {
            app: { ...application, environment: "preview" },
            gateway: configuration.gateway,
            operator: configuration.operator,
            verification: {
              gatewayOrigin: configuration.gateway.gatewayOrigin,
              publicOrigin: configuration.gateway.publicOrigin,
            },
          },
          context,
          phase: "bootstrap-planning",
          resolveGatewayByPublicOrigin: true,
          readVercelCredential: async ({ authority, installationId }) =>
            await controlPlane.readCredential(authority, installationId),
        }),
    );
    const native = configuration.nativeNeon.scope;
    const activeAuth = await observe(
      "shared_auth_read",
      async () => await controlPlane.readActiveSharedAuth(context),
    );
    const adoptionSource = application.authAdoptionSource;
    const adopted =
      activeAuth !== undefined || adoptionSource === undefined
        ? undefined
        : await observe(
            "auth_adoption_read",
            async () =>
              await controlPlane.readSharedAuthAdoption({
                context,
                source: adoptionSource,
              }),
          );
    if (
      current?.record.operator?.plan.authAdoption !== undefined &&
      adopted === undefined &&
      activeAuth === undefined
    ) {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    let authSchema =
      activeAuth?.authSchema ??
      current?.record.operator?.plan.authSchema ??
      current?.record.retainedAuth?.plan.authSchema;
    // Read under the original completed approval before the next plan replaces it.
    // Shared adoption keeps its source artifact and read-only execution contract.
    const originalPlan =
      current?.record.operator?.authPreparation !== undefined &&
      current.record.operator.plan.action === "prepare"
        ? current.record.operator.plan
        : current?.record.retainedAuth?.plan;
    const bindingPlan =
      adopted === undefined && activeAuth === undefined && originalPlan?.authAdoption === undefined
        ? originalPlan
        : undefined;
    if (activeAuth !== undefined && authSchema === undefined) {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    const existingBindings =
      bindingPlan === undefined
        ? undefined
        : await observe(
            "shared_auth_read",
            async () =>
              await privateBindings({
                ...context,
                plan: bindingPlan,
                privateState: current?.record.privateState,
              }),
          );
    const existingMigrationUrl = existingBindings?.authDatabase.migrationUrl;
    if (adopted !== undefined) {
      const artifactRef = await observe(
        "auth_schema_publish",
        async () =>
          await controlPlane.publishAuthPlan(context, {
            content: adopted.content,
            planDigest: adopted.authSchema.planDigest,
            targetDigest: adopted.authSchema.targetDigest,
          }),
      );
      authSchema = { ...adopted.authSchema, artifactRef };
    } else if (existingMigrationUrl !== undefined || authSchema === undefined) {
      const proposed = await observe(
        "auth_schema_proposal",
        async () =>
          await proposal({
            assertCurrentOwner: async () => {
              await controlPlane.assertPlanningAuthorized(context);
              if (bindingPlan !== undefined) {
                const latest = await privateBindings({
                  ...context,
                  plan: bindingPlan,
                  privateState: current?.record.privateState,
                });
                if (latest.authDatabase.migrationUrl !== existingMigrationUrl) {
                  throw new HostedOperatorError(RESOURCE_MISMATCH);
                }
              }
            },
            ...(existingMigrationUrl === undefined
              ? {}
              : { directMigrationUrl: existingMigrationUrl }),
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
          }),
      );
      const artifactRef = await observe(
        "auth_schema_publish",
        async () => await controlPlane.publishAuthPlan(context, proposed),
      );
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
    const worker = await observe("worker_selection", () => {
      const selectedWorker = configuration.sandbox.workers[context.target.appId];
      if (selectedWorker === undefined) {
        throw new HostedOperatorError("operator_unavailable");
      }
      return selectedWorker;
    });
    const base = await observe("plan_construction", () =>
      hostedOperatorPlanSchema.parse({
        access: [],
        action: "prepare",
        appDatabase: application.appDatabase,
        authAdoption: activeAuth?.adoption ?? adopted?.adoption,
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
            adopted === undefined && activeAuth === undefined
              ? "Preview-only resources and Auth bootstrap. Explicit normal Git delivery retries may create duplicate owned Preview deployments and provider usage charges. No human login or app preparation is established by schema readiness."
              : "Adopt the reviewed shared Auth credentials after independent Auth readiness and canonical Gateway checks, then prepare this app’s separate database and bindings. Retain shared Auth users, sessions, credentials, and sibling Gateway settings.",
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
            description:
              adopted === undefined && activeAuth === undefined
                ? "Prepare or observe the exact owned shared Auth database and roles."
                : "Verify the approved shared Auth and Gateway ownership, then activate an independent encrypted Auth credential copy; never recreate or rotate shared Auth.",
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
            description:
              adopted === undefined && activeAuth === undefined
                ? "Independently replan and migrate the approved shared Auth target."
                : "Require independent read-only Auth schema adoption; migration and recreation remain blocked.",
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
        publicGateway: createHostedOperatorPublicGateway(inventory, configuration.gateway.branch),
        release: {
          artifactRef: selection.artifactRef,
          id: selection.releaseId,
          sha256: selection.manifestSha256,
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
        normalActorProgram:
          context.normalActorProgram ??
          current?.record.accountPreparation?.program ??
          current?.record.operator?.plan.normalActorProgram,
        version: 1,
      }),
    );
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
    let participantsBootstrapPrepared = false;
    if (
      gatewayPlan.normalActorProgram !== undefined &&
      inspectParticipantBootstrapPreparation(gatewayPlan, current?.record).gatewayPrepared &&
      current?.record.operator !== undefined
    ) {
      const verification = {
        ...context,
        plan: current.record.operator.plan,
        privateState: current.record.privateState,
        assertCurrent: async () => {
          await controlPlane.assertPlanningAuthorized(context);
        },
      };
      await authReadiness.verify(verification);
      participantsBootstrapPrepared = true;
    }
    return await observe(
      "identity_plan_resolution",
      async () =>
        await resolveFullPlan(
          gatewayPlan,
          context,
          configuration,
          controlPlane,
          {},
          participantsBootstrapPrepared,
          current?.record.status === "participants-prepared" ||
            current?.record.operator?.plan.stage === "app",
          selection,
          context.authSignupPolicy,
        ),
    );
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
    if (
      input.plan.authAdoption !== undefined &&
      input.effect.resourceId === input.plan.authDatabase.resourceId
    ) {
      const frozen = {
        ...input,
        authority: structuredClone(input.authority),
        deliveryCandidates: structuredClone(input.deliveryCandidates),
        effect: structuredClone(input.effect),
        gatewayEnvironmentRows: structuredClone(input.gatewayEnvironmentRows),
        ownerContext: structuredClone(input.ownerContext),
        plan: structuredClone(input.plan),
        target: structuredClone(input.target),
      };
      const source = structuredClone(selectedApplication(configuration, frozen).authAdoptionSource);
      const canonicalInput = gatewayContext(frozen);
      await controlPlane.checkpointSharedAuthAdoption({ effect: frozen, source });
      const proof = await controlPlane.verifySharedAuthAdoption({
        activate: true,
        effect: frozen,
        source,
        verifyCanonicalOwnership: async () => {
          const observed = await gatewayEnvironment.verifyCanonicalOwnership(canonicalInput);
          return observed.rows;
        },
      });
      return { readback_sha256: proof.catalogFingerprint, status: "applied" as const };
    }
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
      input.plan.authMembership.kind !== "create-owned-organization" ||
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
  const signupPolicyWorkerInput = async (input: HostedOperatorEffectContext) => {
    if (input.plan.normalActorProgram === undefined && input.plan.authMembership !== undefined) {
      return await membershipInput(input);
    }
    if (
      input.plan.authSignupPolicy === undefined ||
      input.plan.normalActorProgram === undefined ||
      controlPlane.readNormalActorPreparation === undefined ||
      configuration.sandbox.membershipWorker === undefined
    ) {
      throw new HostedOperatorError(AUTH_MEMBERSHIP_REQUIRED);
    }
    const prepared = await controlPlane.readNormalActorPreparation(input);
    if (prepared === undefined) {
      throw new HostedOperatorError(RECONCILIATION_REQUIRED);
    }
    assertParticipantSignupPolicyState(input, prepared.state);
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
      membershipProof: {
        oidcToken,
        organizationId: input.plan.authSignupPolicy.organizationId,
      },
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
    if (input.plan.authAdoption !== undefined) {
      // A missing or mismatched adopted realm never falls through to genesis.
      const observed = await authReadiness.verify(input);
      return { receipt: receipt(input, observed.catalogFingerprint), status: "applied" };
    }
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
    if (input.effect.kind === "access" && input.plan.normalActorProgram !== undefined) {
      assertParticipantAccess(input.plan, await controlPlane.verifyNormalActorMemberships(input));
    }
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
    if (hasFailedGatewayDelivery(input, observed, configuration.gateway.gitSha)) {
      throw new HostedOperatorError("gateway_delivery_failed");
    }
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
    if (input.plan.normalActorProgram !== undefined) {
      const observed = await controlPlane.reconcileNormalActorMemberships(input);
      if (observed.status !== "applied") {
        return { status: observed.status };
      }
      const prepared = await controlPlane.readNormalActorPreparation(input);
      if (prepared === undefined) {
        throw new HostedOperatorError(RECONCILIATION_REQUIRED);
      }
      const state = assertParticipantOrganization(input, prepared.state);
      return { receipt: receipt(input, normalActorFingerprint(state)), status: "applied" };
    }
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
  const reconcileAuthSignupPolicy = async (
    input: HostedOperatorEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["reconcile"]> => {
    if (
      input.plan.authSignupPolicy === undefined ||
      (input.plan.authMembership === undefined && input.plan.normalActorProgram === undefined)
    ) {
      return { status: "absent" };
    }
    const observed = await launcher.inspect({
      ...input,
      assertCurrent: async () => {
        if (input.plan.normalActorProgram === undefined) {
          await controlPlane.assertMembershipCapture(input);
          return;
        }
        const prepared = await controlPlane.readNormalActorPreparation(input);
        if (prepared === undefined) {
          throw new HostedOperatorError(RECONCILIATION_REQUIRED);
        }
        assertParticipantSignupPolicyState(input, prepared.state);
      },
      ...(await signupPolicyWorkerInput(input)),
      readbackOnly: true,
    });
    if (observed?.status === "applied" && observed.readback_sha256 !== undefined) {
      return { receipt: receipt(input, observed.readback_sha256), status: "applied" };
    }
    if (observed?.status === "absent") {
      return { status: "absent" };
    }
    return { status: "unknown" };
  };
  const reconcileHandlers: Partial<
    Record<
      HostedOperatorPlan["effects"][number]["kind"],
      ProtectedHostedOperatorDependencies["reconcile"]
    >
  > = {
    "normal-accounts": async (input) => {
      const prepared = await controlPlane.readNormalActorPreparation(input);
      if (prepared === undefined) {
        return { status: "absent" };
      }
      if (prepared.state.actors.some((actor) => actor.signup !== "complete")) {
        return { status: "retryable", resourceVersion: normalActorFingerprint(prepared.state) };
      }
      if (input.checkpointAccountPreparation === undefined) {
        throw new HostedOperatorError(OPERATION_IN_PROGRESS);
      }
      try {
        const state = await controlPlane.verifyNormalActorAccounts({
          ...input,
          accountPreparation: prepared.preparation,
          checkpointAccountPreparation: input.checkpointAccountPreparation,
        });
        return { status: "applied", receipt: receipt(input, normalActorFingerprint(state)) };
      } catch {
        return { status: "unknown" };
      }
    },
    access: reconcileAppWorker,
    "auth-membership": reconcileAuthMembership,
    [AUTH_SIGNUP_POLICY]: reconcileAuthSignupPolicy,
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
    if (input.plan.authAdoption !== undefined) {
      const observed = await authReadiness.verify(input);
      return receipt(input, observed.catalogFingerprint);
    }
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
    if (input.effect.kind === "access" && input.plan.normalActorProgram !== undefined) {
      assertParticipantAccess(input.plan, await controlPlane.verifyNormalActorMemberships(input));
    }
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
    if (hasFailedGatewayDelivery(input, observed, configuration.gateway.gitSha)) {
      throw new HostedOperatorError("gateway_delivery_failed");
    }
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
    if (input.plan.normalActorProgram !== undefined) {
      const state = assertParticipantOrganization(
        input,
        await controlPlane.prepareNormalActorMemberships(input),
      );
      return receipt(input, normalActorFingerprint(state));
    }
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
  const executeEffectAuthSignupPolicy = async (
    input: HostedOperatorWorkerEffectContext,
  ): ReturnType<ProtectedHostedOperatorDependencies["executeEffect"]> => {
    await launcher.execute({
      ...input,
      assertCurrent: async () => {
        if (input.plan.normalActorProgram === undefined) {
          await controlPlane.assertMembershipCapture(input);
          return;
        }
        const prepared = await controlPlane.readNormalActorPreparation(input);
        if (prepared === undefined) {
          throw new HostedOperatorError(RECONCILIATION_REQUIRED);
        }
        assertParticipantSignupPolicyState(input, prepared.state);
      },
      ...(await signupPolicyWorkerInput(input)),
    });
    const observed = await reconcileAuthSignupPolicy(input);
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
    "normal-accounts": async (input) => {
      const program = input.plan.normalActorProgram;
      if (program === undefined || input.checkpointAccountPreparation === undefined) {
        throw new HostedOperatorError(OPERATION_IN_PROGRESS);
      }
      const state = await controlPlane.prepareNormalActorAccounts(input);
      const operation = input.accountPreparation?.accountOperationRef ?? input.operationRef;
      const checked = assertNormalActorState(program, state, operation);
      if (
        checked.actors.some(
          (actor) =>
            actor.signup !== "complete" ||
            actor.session === undefined ||
            actor.storageState === undefined,
        )
      ) {
        throw new HostedOperatorError(RECONCILIATION_REQUIRED);
      }
      return receipt(input, normalActorFingerprint(checked));
    },
    access: executeEffectAppWorker,
    "auth-membership": executeEffectAuthMembership,
    [AUTH_SIGNUP_POLICY]: executeEffectAuthSignupPolicy,
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
    if (input.plan.stage === "auth-participants") {
      return await controlPlane.normalActorAuthIdentityInput(input);
    }
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
    const link = operator.identityLink;
    const capturedOwner = [
      operator.plan.normalActorProgram === undefined,
      link?.browserSession === undefined,
      link?.bootstrapPlanDigest === operator.planDigest,
      link?.ownerSessionId === input.target.sessionId,
      link?.authResourceId === operator.plan.authDatabase.resourceId,
      link?.consumedAt !== undefined,
      link?.proofRef !== undefined,
      link?.proofSha256 !== undefined,
    ].every(Boolean);
    if (capturedOwner) {
      // Consumption raced the preceding execute read. Preserve its canonical nonce and re-read preparation.
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
      phase: "bootstrap-planning",
      approvedAppBranch: boundary.app.branch,
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
    assertCanonicalOwner: controlPlane.assertCanonicalOwner,
    authIdentityInput,
    authorize: controlPlane.authorize,
    authorizeNeonConsent: consentOwner.authorize,
    resolvePreviewTarget: createConfiguredPreviewTargetResolver(
      configuration,
      consentOwner,
      controlPlane,
    ),
    bindings,
    normalActorRuntimeBindings: async (input) =>
      await controlPlane.readNormalActorRuntimeBindings(input),
    executeEffect,
    neonAuthorization: createHostedOperatorNeonAuthorization({
      assertCurrentOwner: consentOwner.assertCurrent,
      configuration: neonAuthorizationConfigurationSchema.parse({
        builderCallbackOrigin: configuration.builderCallbackOrigin,
        builderWorkload: configuration.workloadPolicy,
        operatorWorkload: configuration.nativeNeon.configuration.operator,
      }),
    }),
    plan,
    readApproval: controlPlane.readApproval,
    readApprovedPlan: controlPlane.readApprovedPlan,
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
        approvedAppBranch: input.plan.deploymentBoundary.app.branch,
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
    verifyNormalActorAccounts: async (input) => await controlPlane.verifyNormalActorAccounts(input),
    ensureNormalActorCapture: async (input) => await controlPlane.ensureNormalActorCapture(input),
    withResourceLease: controlPlane.withResourceLease,
  };
};

// oxlint-disable-next-line eslint/require-await -- Promise-returning resource adapters reject consent-only setup before any effect.
const unavailable = async (): Promise<never> => {
  throw new HostedOperatorError("protected_operator_required");
};

export const composeHostedOperatorAuthorizationDependencies = (
  configuration: ReturnType<typeof readNeonAuthorizationConfiguration>,
  ownerAuthority?: ReturnType<typeof createHostedOperatorConsentOwner>,
): ProtectedHostedOperatorDependencies => {
  const consentOwner =
    ownerAuthority ?? createHostedOperatorConsentOwner(configuration.builderWorkload);
  return {
    assertAuthorized: unavailable,
    authorize: unavailable,
    authorizeNeonConsent: consentOwner.authorize,
    bindings: unavailable,
    executeEffect: unavailable,
    neonAuthorization: createHostedOperatorNeonAuthorization({
      assertCurrentOwner: consentOwner.assertCurrent,
      configuration,
    }),
    plan: unavailable,
    readApproval: unavailable,
    reconcile: unavailable,
    store: {
      compareAndSet: unavailable,
      read: unavailable,
      reserve: unavailable,
      reserveFenceGeneration: unavailable,
    },
    verify: unavailable,
    withResourceLease: unavailable,
  };
};

export const createDependencies = async (): Promise<ProtectedHostedOperatorDependencies> => {
  if (
    process.env.PROTECTED_HOSTED_OPERATOR_CONFIGURATION === undefined ||
    process.env.PROTECTED_HOSTED_OPERATOR_CONFIGURATION === ""
  ) {
    const configuration = readNeonAuthorizationConfiguration(process.env);
    return composeHostedOperatorAuthorizationDependencies(configuration);
  }
  const { configuration, controlPlane } = await openHostedOperatorCompositionResources();
  return composeHostedOperatorDependencies(configuration, controlPlane);
};
