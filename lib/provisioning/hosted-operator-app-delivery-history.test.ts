import { expect, it } from "vitest";
import {
  checkpointActiveAppEnvironment,
  retainAppDeliveryHistory,
  ownedAppEnvironmentRows,
  planOwnedAppEnvironmentCleanup,
  checkpointOwnedAppEnvironmentCleanup,
} from "./hosted-operator-app-delivery-history";
import {
  hostedOperatorPlanSchema,
  hostedOperatorRecordSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { OperatorSelection } from "./hosted-operator-contract";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection: OperatorSelection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview",
  projectId: "prj_fixture",
  sessionId: "session_fixture",
};
const basePlan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "synthetic-reviewer", organizationId: "synthetic-org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "shared_auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "shared_auth_runtime",
  },
  contextId: "synthetic-context",
  cost: {
    class: "shared-recovery-group",
    description: "Approved disposable compute",
    owner: "Fixture owner",
  },
  effects: [
    {
      description: "Verify selected resources and their roles",
      id: "resources",
      kind: "resources",
    },

    { description: "Install the selected checked release", id: "install", kind: "install" },
    { description: "Grant approved Auth app access after install", id: "access", kind: "access" },
    {
      description: "Bind restricted app and shared Auth credentials",
      id: "bind",
      kind: "bindings",
    },
  ],
  installer: { reference: "trusted-toolchain", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_synthetic",
    connectionRef: "explicit-owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "synthetic-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: selection.projectId,
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});

const sourcePlan = (branch: string) =>
  hostedOperatorPlanSchema.parse({
    ...basePlan,
    stage: "app",
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    resourcesInstaller: { reference: "resource-worker", sha256: "d".repeat(64) },
    publicGateway: {
      projectId: "prj_gateway",
      branch: selection.branch,
      origin: "https://apps-preview.example.test",
    },
    deploymentBoundary: {
      authority,
      teamId: "team_fixture",
      app: { projectId: selection.projectId, branch, environment: "preview" },
      gateway: { projectId: "prj_gateway", branch: selection.branch, environment: "preview" },
      operator: {
        projectId: "prj_operator",
        environment: "preview",
        deploymentId: "operator-deployment",
      },
      verification: {
        gatewayOrigin: "https://gateway.example.test",
        publicOrigin: "https://apps-preview.example.test",
        jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      },
    },
    delivery: {
      projectId: selection.projectId,
      repoId: "actual-app-repository",
      branch,
      gitSha: "c".repeat(40),
    },
    effects: [
      {
        id: "auth-resources",
        kind: "resources",
        description: "Auth resources",
        resourceId: basePlan.authDatabase.resourceId,
      },
      {
        id: "app-resources",
        kind: "resources",
        description: "App resources",
        resourceId: basePlan.appDatabase.resourceId,
      },
      ...basePlan.effects.filter((effect) => effect.kind !== "resources"),
      { id: "delivery", kind: "delivery", description: "Actual delivery" },
    ],
  });
const oldPlan = sourcePlan("codex/generated-old");
const newPlan = sourcePlan("codex/generated-new");
const operationRef = "00000000-0000-4000-8000-000000000001";
const old = hostedOperatorRecordSchema.parse({
  mode: "protected-operator-v1",
  operationRef,
  plan: oldPlan,
  planDigest: operatorPlanDigest(oldPlan),
  receipts: [],
  managedEnvironment: [
    {
      id: "old-owned-row",
      key: "SPEND_REVIEW_DATABASE_URL",
      branch: oldPlan.delivery?.branch,
      projectId: selection.projectId,
      operationRef,
      comment: `App Builder protected operator ${operationRef}`,
    },
  ],
  deliveryCandidates: [
    {
      branch: oldPlan.delivery?.branch,
      projectId: selection.projectId,
      operationRef,
      readyState: "READY",
      origin: "https://old-app.example.test",
      repoId: "actual-app-repository",
      deploymentId: "old-app-deployment",
    },
  ],
});

const transitioned = () =>
  retainAppDeliveryHistory(old, {
    ...old,
    operationRef: "00000000-0000-4000-8000-000000000002",
    plan: newPlan,
    planDigest: operatorPlanDigest(newPlan),
    deliveryCandidates: [],
    managedEnvironment: [],
  });
it("preserves actual prior source and owned rows when the published branch changes", () => {
  const next = hostedOperatorRecordSchema.parse(transitioned());
  expect(next.deliveryCandidates).toEqual([]);
  expect(next.managedEnvironment).toEqual([]);
  expect(next.retainedAppDeliveries?.[0]).toMatchObject({
    delivery: oldPlan.delivery,
    deliveryCandidates: old.deliveryCandidates,
    managedEnvironment: old.managedEnvironment,
    operationRef,
    planDigest: old.planDigest,
  });
  expect(next.plan.selection).toEqual(old.plan.selection);
  expect(next.plan.appDatabase).toEqual(old.plan.appDatabase);
  const returned = hostedOperatorRecordSchema.parse(
    retainAppDeliveryHistory(next, { ...next, plan: oldPlan, planDigest: old.planDigest }),
  );
  expect(returned.managedEnvironment).toEqual(old.managedEnvironment);
  expect(returned.deliveryCandidates).toEqual(old.deliveryCandidates);
  expect(returned.retainedAppDeliveries).toEqual(
    expect.arrayContaining(next.retainedAppDeliveries ?? []),
  );
});
it("freezes exact saved cleanup scopes and preserves provenance after confirmed removal", () => {
  const next = transitioned();
  const cleanup = planOwnedAppEnvironmentCleanup(
    {
      ...newPlan,
      action: "cleanup",
      effects: [
        { id: "revoke", kind: "revoke", description: "Revoke access" },
        { id: "remove", kind: "remove-bindings", description: "Remove owned rows" },
        {
          id: "retire",
          kind: "retire",
          resourceId: newPlan.appDatabase.resourceId,
          description: "Retire owned resources",
        },
      ],
    },
    next,
  );
  // Cleanup does not create a new app deployment.
  delete cleanup.delivery;
  expect(hostedOperatorPlanSchema.parse(cleanup).appEnvironmentCleanup).toEqual(
    old.managedEnvironment,
  );
  expect(
    cleanup.effects.find((effect) => effect.kind === "remove-bindings")?.description,
  ).toContain("codex/generated-old");
  expect(ownedAppEnvironmentRows(next)).toEqual(old.managedEnvironment);
  const cleaned = checkpointOwnedAppEnvironmentCleanup(next, []);
  expect(ownedAppEnvironmentRows(cleaned)).toEqual([]);
  expect(cleaned.retainedAppDeliveries?.[0].delivery).toEqual(oldPlan.delivery);
  expect(cleaned.retainedAppDeliveries?.[0].deliveryCandidates).toEqual(old.deliveryCandidates);
});
it("rejects archived rows outside the actual owned project and original operation tag", () => {
  const next = transitioned();
  const [retained] = next.retainedAppDeliveries;
  for (const changed of [{ projectId: "other-project" }, { comment: "other-owner" }]) {
    expect(
      hostedOperatorRecordSchema.safeParse({
        ...next,
        retainedAppDeliveries: [
          {
            ...retained,
            managedEnvironment: retained.managedEnvironment.map((row) => ({ ...row, ...changed })),
          },
        ],
      }).success,
    ).toBe(false);
  }
});

it("reactivates the latest actual branch snapshot after an observed row replacement", () => {
  const b = hostedOperatorRecordSchema.parse(transitioned());
  const a = retainAppDeliveryHistory(b, { ...b, plan: oldPlan, planDigest: old.planDigest });
  const observedEmpty = checkpointActiveAppEnvironment(a, []);
  const replacement = (old.managedEnvironment ?? []).map((row) => ({
    ...row,
    id: "replacement-owned-row",
  }));
  const rebound = checkpointActiveAppEnvironment(observedEmpty, replacement);
  const againB = hostedOperatorRecordSchema.parse(
    retainAppDeliveryHistory(rebound, {
      ...rebound,
      plan: newPlan,
      planDigest: operatorPlanDigest(newPlan),
    }),
  );
  const againA = hostedOperatorRecordSchema.parse(
    retainAppDeliveryHistory(againB, { ...againB, plan: oldPlan, planDigest: old.planDigest }),
  );
  expect(againA.managedEnvironment).toEqual(replacement);
  expect(ownedAppEnvironmentRows(againA)).toEqual(replacement);
  expect(againA.retainedAppDeliveries?.[0].delivery).toEqual(oldPlan.delivery);
});

it("keeps current branch observations authoritative and retains a newer empty scope", () => {
  const b = transitioned();
  const a = retainAppDeliveryHistory(b, { ...b, plan: oldPlan, planDigest: old.planDigest });
  const replaced = checkpointActiveAppEnvironment(
    a,
    (old.managedEnvironment ?? []).map((row) => ({ ...row, id: "current-row" })),
  );
  const same = hostedOperatorRecordSchema.parse(
    retainAppDeliveryHistory(replaced, { ...replaced }),
  );
  expect(same.managedEnvironment).toEqual(replaced.managedEnvironment);
  const empty = checkpointActiveAppEnvironment(same, []);
  const left = retainAppDeliveryHistory(empty, {
    ...empty,
    plan: newPlan,
    planDigest: operatorPlanDigest(newPlan),
  });
  const returned = hostedOperatorRecordSchema.parse(
    retainAppDeliveryHistory(left, { ...left, plan: oldPlan, planDigest: old.planDigest }),
  );
  expect(returned.managedEnvironment).toEqual([]);
  expect(ownedAppEnvironmentRows(returned)).toEqual([]);
});
