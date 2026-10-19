/* oxlint-disable eslint/require-await -- In-memory async service ports preserve the real handler contract without provider operations. */
import { describe, expect, it, vi } from "vitest";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import {
  hostedOperatorPlanSchema,
  hostedOperatorRecordSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
} from "./hosted-operator-contract";
import type { OperatorSelection, OperatorRequest } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import { retainedConsumedIdentityLink } from "./hosted-operator-identity-link-carry";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection: OperatorSelection = {
  appId: "fixture-app",
  branch: "preview",
  environment: "preview",
  projectId: "prj_fixture",
  sessionId: "session_fixture",
};
const target = {
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
};
const plan = hostedOperatorPlanSchema.parse({
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
  deploymentBoundary: {
    app: {
      branch: selection.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: selection.projectId,
    },
    authority,
    gateway: {
      branch: selection.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: {
      deploymentId: "dpl_operator",
      environment: "production",
      projectId: "prj_operator",
    },
    teamId: "team_fixture",
    verification: {
      gatewayOrigin: "https://gateway-preview.example.test",
      jwksUrl: "https://gateway-preview.example.test/_platform/jwks.json",
      publicOrigin: "https://apps-preview.example.test",
    },
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
    projectId: "prj_gateway",
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});
const preparedOwnerFixture = (observedEndpoint: boolean) => {
  const originalPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    authSchema: {
      artifactRef: "auth-plan",
      installer: plan.installer,
      planDigest: "a".repeat(64),
      targetDigest: "b".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    gatewayBindings: {
      authBrowserOrigin: "https://auth-preview.example.test",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [selection.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload: {
        audience: "https://vercel.com",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team_fixture",
        ownerId: "team_fixture",
        projectId: "prj_gateway",
        subject: "fixture-gateway",
      },
    },
    resourcesInstaller: plan.installer,
    effects: [
      {
        id: "auth-resources",
        kind: "resources",
        resourceId: plan.authDatabase.resourceId,
        description: "Observe owned Auth",
      },
      {
        id: "app-resources",
        kind: "resources",
        resourceId: plan.appDatabase.resourceId,
        description: "Observe owned app",
      },
      ...plan.effects.filter((effect) => effect.kind !== "resources"),
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Bind shared Gateway" },
    ],
  });
  const operationRef = "00000000-0000-4000-8000-000000000001";
  const planDigest = operatorPlanDigest(originalPlan);
  const identityLink = {
    audience: "https://operator.example",
    authResourceId: originalPlan.authDatabase.resourceId,
    bootstrapPlanDigest: planDigest,
    browserOrigin: "https://auth-preview.example.test",
    endpointOrigin: "https://gateway-preview.example.test",
    issuer: "https://apps-preview.example.test",
    ownerSessionId: selection.sessionId,
    organizationId: null,
    nonceSha256: "d".repeat(64),
    expiresAt: "2026-10-01T00:00:00Z",
    consumedAt: "2026-09-30T23:59:00Z",
    proofRef: "original-approved-owner-proof",
    proofSha256: "e".repeat(64),
  };
  let row: HostedRuntimeJournalRow = {
    revision: 1,
    record: hostedRuntimeJournalRecordSchema.parse({
      version: 1,
      kind: "app-runtime",
      approvedByCallId: "original-approved-call",
      request: target,
      status: "prepared",
      step: "bound",
      environmentBound: true,
      privateState: {
        encryptedToken: "ciphertext",
        keyVersion: "key-v1",
        tokenIv: "iv",
        tokenTag: "tag",
      },
      proof: {
        actors: 0,
        tenants: 1,
        authenticatedBehavior: "unassessed",
        artifactHash: "c".repeat(64),
        manifestSha256: originalPlan.release.sha256,
        releaseId: originalPlan.release.id,
      },
      operator: {
        mode: "protected-operator-v1",
        approvalId: "original-approval",
        operationRef,
        plan: originalPlan,
        planDigest,
        fenceGeneration: 1,
        identityLink,
        authPreparation: {
          assetSha256: "1".repeat(64),
          catalogFingerprint: "2".repeat(64),
          database: originalPlan.authDatabase.database,
          runtimeRole: originalPlan.authDatabase.runtimeRole,
          targetDigest: originalPlan.authSchema?.targetDigest,
          observedAt: "2026-10-19T12:00:00Z",
        },
        receipts: originalPlan.effects.map((effect) => ({
          effectId: effect.id,
          observedAt: "2026-10-19T12:00:00Z",
          resourceVersion: "observed",
          fenceGeneration: 1,
        })),
        ...(observedEndpoint
          ? {
              deliveredGatewayDeploymentId: "ready-owner-gateway",
              gatewayDeliveryCandidates: [
                {
                  deploymentId: "ready-owner-gateway",
                  readyState: "READY",
                  origin: identityLink.endpointOrigin,
                  branch: "preview",
                  projectId: "prj_gateway",
                  repoId: "gateway-repo",
                  operationRef,
                },
              ],
            }
          : {}),
      },
    }),
  };
  const original = structuredClone(row.record);
  const deps: ProtectedHostedOperatorDependencies = {
    authorize: vi.fn(async () => ({ authority, target })),
    assertAuthorized: vi.fn(async () => {}),
    plan: vi.fn(async () => originalPlan),
    readApproval: vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(async (input) =>
      input.planDigest === planDigest && input.callId === original.approvedByCallId
        ? {
            action: "prepare",
            approvalId: "original-approval",
            approved: true,
            callId: original.approvedByCallId,
            planDigest,
          }
        : null,
    ),
    store: {
      read: async () => structuredClone(row),
      reserve: async () => structuredClone(row),
      compareAndSet: async (input) => {
        if (input.expectedRevision !== row.revision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- A lost journal CAS returns no row.
          return undefined;
        }
        row = {
          revision: row.revision + 1,
          record: hostedRuntimeJournalRecordSchema.parse(input.record),
        };
        return structuredClone(row);
      },
      reserveFenceGeneration: vi.fn(async () => {
        throw new Error("Planning cannot claim an effect fence");
      }),
    },
    executeEffect: vi.fn(async () => {
      throw new Error("Planning cannot execute effects");
    }),
    reconcile: vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(async () => ({
      status: "absent",
    })),
    verify: vi.fn(async () => {
      throw new Error("Planning cannot publish readiness");
    }),
    bindings: vi.fn(async () => ({})),
    withResourceLease: vi.fn(async () => {
      throw new Error("Planning cannot claim an effect lease");
    }),
  };
  const handler = createProtectedHostedOperatorHandler(deps);
  const client = {
    request: async (input: OperatorRequest) => {
      const response = await handler(
        new Request("https://operator.example/v1/runtime", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      return operatorPublicResultSchema.parse(await response.json());
    },
  };
  return { deps, client, originalPlan, original, identityLink, row: () => row };
};

describe("participant proposal identity continuity", () => {
  it("preserves the original prepared operation when its retained Auth approval is unavailable", async () => {
    const f = preparedOwnerFixture(false);
    f.deps.plan = async () =>
      hostedOperatorPlanSchema.parse({
        ...f.originalPlan,
        release: { ...f.originalPlan.release, id: "new-release" },
      });
    f.deps.readApproval = async () => null;
    const result = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(result).toMatchObject({ status: "blocked", code: "authorization_required" });
    expect(f.row().record).toEqual(f.original);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });

  it.each(["auth-resource", "owner-session"] as const)(
    "keeps the full identity invariant when successor %s changes",
    (scope) => {
      const f = preparedOwnerFixture(false);
      const prior = hostedOperatorRecordSchema.parse(f.original.operator);
      const successor = structuredClone(prior);
      if (scope === "auth-resource") {
        successor.plan.authDatabase.resourceId = "different-auth-resource";
        successor.plan.effects = successor.plan.effects.map((effect) =>
          effect.resourceId === prior.plan.authDatabase.resourceId
            ? { ...effect, resourceId: successor.plan.authDatabase.resourceId }
            : effect,
        );
      } else {
        successor.plan.selection.sessionId = "different-owner-session";
      }
      hostedOperatorPlanSchema.parse(successor.plan);
      expect(retainedConsumedIdentityLink(prior, successor)).toBeUndefined();
      expect(hostedOperatorRecordSchema.safeParse(successor).success).toBe(false);
      expect(f.row().record).toEqual(f.original);
    },
  );

  it("preserves a pending link when re-exposing its unchanged original plan", async () => {
    const f = preparedOwnerFixture(false);
    const record = f.row().record;
    const link = record.operator?.identityLink;
    if (link === undefined) {
      throw new Error("Missing fixture link");
    }
    delete link.consumedAt;
    delete link.proofRef;
    delete link.proofSha256;
    const pending = structuredClone(link);
    const result = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(result.code).toBeUndefined();
    expect(f.row().record.operator?.identityLink).toEqual(pending);
    expect(f.row().record.privateState).toEqual(f.original.privateState);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });

  it.each(["unchanged", "browser", "issuer", "endpoint", "observed-endpoint"] as const)(
    "plans from a valid prepared owner record with %s scope without transferring incompatible proof",
    async (scope) => {
      const f = preparedOwnerFixture(scope === "observed-endpoint");
      const { originalPlan, identityLink } = f;
      const publicOrigin =
        scope === "issuer" ? "https://next-apps.example.test" : identityLink.issuer;
      const boundary = originalPlan.deploymentBoundary;
      if (!boundary || !originalPlan.gatewayBindings || !originalPlan.publicGateway) {
        throw new Error("Missing fixture scope");
      }
      const proposal = hostedOperatorPlanSchema.parse({
        ...originalPlan,
        access: [],
        stage: "auth-bootstrap",
        effects: originalPlan.effects.filter((effect) =>
          ["resources", "install", "gateway-bindings"].includes(effect.kind),
        ),
        publicGateway: { ...originalPlan.publicGateway, origin: publicOrigin },
        deploymentBoundary: {
          ...boundary,
          verification: {
            ...boundary.verification,
            publicOrigin,
            jwksUrl: ["endpoint", "observed-endpoint"].includes(scope)
              ? "https://next-gateway.example.test/_platform/jwks.json"
              : boundary.verification.jwksUrl,
            gatewayOrigin: ["endpoint", "observed-endpoint"].includes(scope)
              ? "https://next-gateway.example.test"
              : identityLink.endpointOrigin,
          },
        },
        gatewayBindings: {
          ...originalPlan.gatewayBindings,
          authBrowserOrigin:
            scope === "browser" ? "https://next-auth.example.test" : identityLink.browserOrigin,
        },
        normalActorProgram: {
          version: 1,
          appId: selection.appId,
          origin: publicOrigin,
          actors: [
            {
              actorKey: "reviewer",
              name: "Reviewer",
              email: "reviewer@example.test",
              account: "create-email-password",
            },
          ],
          organizations: [],
          memberships: [],
          appAccess: [],
        },
      });
      f.deps.plan = async () => proposal;
      const result = await f.client.request({
        action: "plan",
        operation: "prepare",
        selection,
        normalActorProgram: proposal.normalActorProgram,
      });
      expect(result.status).toBe("planned");
      const record = f.row().record;
      expect(record.operator?.identityLink).toEqual(
        ["unchanged", "observed-endpoint"].includes(scope) ? identityLink : undefined,
      );
      expect(record.privateState).toEqual(f.original.privateState);
      expect(record.accountPreparation).toEqual(f.original.accountPreparation);
      expect(record.operator?.gatewayEnvironment).toEqual(f.original.operator?.gatewayEnvironment);
      expect(record.retainedAuth?.operationRef).toBe(f.original.operator?.operationRef);
      expect(record.retainedAuth?.approvedByCallId).toBe(f.original.approvedByCallId);
      expect(record.operator?.approvalId).toBeUndefined();
      expect(record.approvedByCallId).toBe("operator:unapproved-plan");
      expect(record.proof).toBeUndefined();
      expect(f.deps.executeEffect).not.toHaveBeenCalled();
      expect(f.deps.verify).not.toHaveBeenCalled();
      expect(f.deps.withResourceLease).not.toHaveBeenCalled();
      expect(f.original.operator?.identityLink).toEqual(identityLink);
    },
  );
});
