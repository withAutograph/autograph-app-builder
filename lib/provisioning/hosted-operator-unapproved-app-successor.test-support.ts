import { encryptNormalActorState } from "./hosted-operator-normal-actor-state";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  normalActorPreparationSchema,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import {
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";

const TEST_APP_ORIGIN = "https://apps.example";
const GATEWAY_DELIVERY_EFFECT = "gateway-delivery";

export const requiredFixture = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Missing fixture value");
  }
  return value;
};

const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
export const context: HostedOperatorContext = {
  authority,
  ownerContext: {
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority,
    kind: "direct",
    principal: { ...authority, scopes: ["autograph:get"] },
    sessionId: "session",
  },
  target: {
    appId: "actual",
    branch: "feature/actual-publication",
    environment: "preview",
    installationId: "installation",
    projectId: "prj_actual",
    scopeId: "team",
    scopeType: "team",
    sessionId: "session",
  },
};
const bootstrapPlan = () =>
  hostedOperatorPlanSchema.parse({
    access: [],
    action: "prepare",
    appDatabase: resource("app"),
    authDatabase: resource("auth"),
    authSchema: {
      artifactRef: "auth-artifact",
      installer: { reference: "auth-worker", sha256: "d".repeat(64) },
      planDigest: "e".repeat(64),
      targetDigest: "f".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    contextId: "spec-digest",
    cost: { class: "shared-recovery-group", description: "Fixture bootstrap", owner: "owner" },
    effects: [
      {
        description: "Auth resources",
        id: "auth-resources",
        kind: "resources",
        resourceId: "auth-resource",
      },
      {
        description: "App resources",
        id: "app-resources",
        kind: "resources",
        resourceId: "app-resource",
      },
      { description: "Auth schema", id: "auth-schema", kind: "install" },
    ],
    installer: { reference: "app-worker", sha256: "a".repeat(64) },
    neon: {
      branchId: "br-fixture",
      connectionRef: "native-connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "neon-fixture",
      source: "synthetic-only",
    },
    release: { artifactRef: "release-artifact", id: "release", sha256: "b".repeat(64) },
    resourcesInstaller: { reference: "resources-worker", sha256: "c".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Retain shared Auth" },
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

const operationRef = "00000000-0000-4000-8000-000000000001";
export const observedAt = "2026-10-14T12:00:00Z";
const sourceWorkload = {
  audience: "https://vercel.com/team",
  environment: "preview" as const,
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  subject: "builder-workload",
};
const desiredPlan = () =>
  hostedOperatorPlanSchema.parse({
    ...bootstrapPlan(),
    normalActorProgram: normalActorProgramSchema.parse({
      actors: [
        {
          account: "create-email-password",
          actorKey: "owner",
          email: "owner@example.test",
          name: "Owner",
        },
      ],
      appAccess: [],
      appId: context.target.appId,
      memberships: [],
      organizations: [],
      origin: TEST_APP_ORIGIN,
      version: 1,
    }),
    publicGateway: {
      branch: context.target.branch,
      origin: TEST_APP_ORIGIN,
      projectId: "gateway",
    },
    deploymentBoundary: {
      authority,
      teamId: "team",
      app: {
        projectId: context.target.projectId,
        deploymentId: "app-deployment",
        branch: context.target.branch,
        environment: "preview",
      },
      gateway: {
        projectId: "gateway",
        deploymentId: "gateway-deployment",
        branch: context.target.branch,
        environment: "preview",
      },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        projectId: "operator",
      },
      verification: {
        gatewayOrigin: "https://gateway.example",
        jwksUrl: "https://gateway.example/_platform/jwks.json",
        publicOrigin: TEST_APP_ORIGIN,
      },
    },
    gatewayBindings: {
      authBrowserOrigin: TEST_APP_ORIGIN,
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [context.target.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload,
    },
    gatewayDelivery: {
      branch: context.target.branch,
      gitSha: "c".repeat(40),
      projectId: "gateway",
      repoId: "gateway-repo",
    },
    effects: [
      ...bootstrapPlan().effects,
      { description: "Gateway configuration", id: "gateway-bindings", kind: "gateway-bindings" },
      {
        description: "Gateway delivery",
        id: GATEWAY_DELIVERY_EFFECT,
        kind: GATEWAY_DELIVERY_EFFECT,
      },
    ],
  });
const completedRecord = (plan: HostedOperatorPlan = desiredPlan()) =>
  hostedRuntimeJournalRecordSchema.parse({
    version: 1,
    kind: "app-runtime",
    approvedByCallId: "ordinary-public-approval",
    request: context.target,
    status: "pending",
    step: "reserved",
    privateState: {
      encryptedToken: "private-ciphertext",
      keyVersion: "key-version",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    operator: {
      mode: "protected-operator-v1",
      approvalId: "actual-approval",
      operationRef,
      plan,
      planDigest: operatorPlanDigest(plan),
      authPreparation: {
        assetSha256: "d".repeat(64),
        catalogFingerprint: "e".repeat(64),
        database: plan.authDatabase.database,
        runtimeRole: plan.authDatabase.runtimeRole,
        targetDigest: plan.authSchema?.targetDigest,
        observedAt,
      },
      receipts: plan.effects.map((effect) => ({
        effectId: effect.id,
        observedAt,
        resourceVersion: "actual-readback",
      })),
      gatewayEnvironment: [
        {
          key: "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
          id: "owned-environment-row",
          projectId: "gateway",
          branch: context.target.branch,
          operationRef,
          comment: `App Builder protected operator ${operationRef}`,
          valueSha256: hostedOperatorRealmLinkConfigSha256(plan),
        },
      ],
      gatewayDeliveryCandidates: [
        {
          projectId: "gateway",
          branch: context.target.branch,
          repoId: "gateway-repo",
          operationRef,
          origin: "https://gateway.example",
          deploymentId: GATEWAY_DELIVERY_EFFECT,
          readyState: "READY",
        },
      ],
      deliveredGatewayDeploymentId: GATEWAY_DELIVERY_EFFECT,
    },
  });

export const captureFixture = () => {
  const template = desiredPlan();
  const original = normalActorProgramSchema.parse({
    ...template.normalActorProgram,
    actors: [
      {
        account: "capture-existing",
        actorKey: "owner",
        email: "owner@example.test",
        name: "Owner",
      },
    ],
  });
  const added = normalActorProgramSchema.parse({
    ...original,
    actors: [
      ...original.actors,
      {
        account: "create-email-password",
        actorKey: "reviewer",
        email: "reviewer@example.test",
        name: "Reviewer",
      },
    ],
  });
  const authPlan = hostedOperatorPlanSchema.parse({
    ...template,
    normalActorProgram: original,
    gatewayDelivery: { ...template.gatewayDelivery, gitRef: context.target.branch },
  });
  const record = completedRecord(authPlan);
  record.retainedAuth = retainedOperatorAuthFromJournal(record);
  const accountPlan = hostedOperatorPlanSchema.parse({
    ...authPlan,
    effects: [{ description: "Accounts", id: "normal-accounts", kind: "normal-accounts" }],
    stage: "auth-participants",
  });
  const accountRef = "00000000-0000-4000-8000-000000000002";
  const preparation = {
    program: original,
    programDigest: normalActorProgramDigest(original),
    accountOperationRef: accountRef,
    accountPlan,
    accountPlanDigest: operatorPlanDigest(accountPlan),
    accountApprovalId: "account-approval",
    accountApprovedByCallId: "account-call",
    sealedState: encryptNormalActorState({
      authority,
      ownerSessionId: context.target.sessionId,
      operationRef: accountRef,
      program: original,
      config: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
      state: initialNormalActorState(original, accountRef),
    }),
    captures: [],
    accountsCompletedAt: observedAt,
  };
  record.accountPreparation = preparation;
  const appPlan = hostedOperatorPlanSchema.parse({
    ...authPlan,
    stage: "app",
    normalActorPreparation: normalActorPreparationSchema.strip().parse(preparation),
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    gatewayDelivery: { ...authPlan.gatewayDelivery, gitRef: undefined },
    effects: [
      ...authPlan.effects.slice(0, 3),
      { description: "Grant", id: "app-access", kind: "access" },
      { description: "Bind", id: "app-bindings", kind: "bindings" },
      ...authPlan.effects.slice(3),
    ],
  });
  const operator = requiredFixture(record.operator);
  operator.plan = appPlan;
  operator.planDigest = operatorPlanDigest(appPlan);
  operator.operationRef = "00000000-0000-4000-8000-000000000003";
  delete operator.approvalId;
  operator.receipts = operator.receipts.filter((receipt) =>
    ["auth-resources", "app-resources", "auth-schema"].includes(receipt.effectId),
  );
  record.approvedByCallId = "operator:unapproved-plan";
  return { added, record };
};
