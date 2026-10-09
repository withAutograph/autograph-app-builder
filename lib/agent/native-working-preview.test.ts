import { describe, expect, it } from "vitest";
import { nativeWorkingPreview } from "./native-working-preview";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../provisioning/hosted-operator-contract";
import type { OperatorSelection } from "../provisioning/hosted-operator-contract";

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
const environment = {};
describe("verified native working Preview projection", () => {
  const nativePlan = () =>
    hostedOperatorPlanSchema.parse({
      ...plan,
      delivery: { branch: selection.branch, projectId: selection.projectId, repoId: "repo-app" },
      effects: [
        ...plan.effects,
        { description: "Native app delivery", id: "delivery", kind: "delivery" },
        {
          description: "Native Gateway delivery",
          id: "gateway-delivery",
          kind: "gateway-delivery",
        },
      ],
      gatewayDelivery: {
        branch: selection.branch,
        projectId: "prj_gateway",
        repoId: "repo-gateway",
      },
    });
  const native = (operationRef: string, nativePlanValue = nativePlan()) => ({
    app: {
      branch: selection.branch,
      deploymentId: "dpl_actual_app",
      operationRef,
      origin: "https://immutable-app.example.test",
      projectId: selection.projectId,
      readyState: "READY",
      repoId: "repo-app",
    },
    expiresAt: plan.retention.expiresAt,
    gateway: {
      branch: selection.branch,
      deploymentId: "dpl_actual_gateway",
      operationRef,
      origin: "https://immutable-gateway.example.test",
      projectId: "prj_gateway",
      readyState: "READY",
      repoId: "repo-gateway",
    },
    operationRef,
    planDigest: operatorPlanDigest(nativePlanValue),
    publicOrigin: "https://apps-preview.example.test",
    verifiedAt: "2026-10-09T12:00:00.000Z",
  });
  const binding = () => {
    const operationRef = "11111111-1111-4111-8111-111111111111";
    return {
      environment,
      nativePreview: native(operationRef),
      operationRef,
      plan: nativePlan(),
      proof: {
        actors: 1,
        artifactHash: "b".repeat(64),
        authenticatedBehavior: "unassessed" as const,
        manifestSha256: plan.release.sha256,
        releaseId: plan.release.id,
        tenants: 1,
      },
    };
  };
  it("publishes canonical app route, preserving release proof without private command identifiers", () => {
    const result = nativeWorkingPreview({
      appId: selection.appId,
      baseRoute: "/spend-review",
      bindings: binding(),
      landingPath: "/",
      now: Date.parse("2026-10-09T12:01:00.000Z"),
    });
    expect(result.workingPreview.url).toBe("https://apps-preview.example.test/spend-review");
    expect(Object.keys(result.workingPreview).toSorted()).toEqual([
      "appId",
      "expiresAt",
      "status",
      "url",
      "verifiedAt",
    ]);
    expect(result.installationProof).toMatchObject({
      authenticatedBehavior: "unassessed",
      releaseId: plan.release.id,
    });
    expect(JSON.stringify(result)).not.toContain("immutable-gateway");
    expect(JSON.stringify(result)).not.toContain("commandId");
  });
  it.each([
    "https://evil.example/spend-review",
    "//evil.example/spend-review",
    "/other-app",
    "/spend-review/../../other-app",
    "/spend-review#private",
    "/spend-review\\other",
  ])("rejects landing path %s", (landingPath) => {
    expect(() =>
      nativeWorkingPreview({
        appId: selection.appId,
        baseRoute: "/spend-review",
        bindings: binding(),
        landingPath,
        now: Date.parse("2026-10-09T12:01:00.000Z"),
      }),
    ).toThrow();
  });
  it("rejects Gateway home as the selected app route", () => {
    expect(() =>
      nativeWorkingPreview({
        appId: selection.appId,
        baseRoute: "/",
        bindings: binding(),
        landingPath: "/",
        now: Date.parse("2026-10-09T12:01:00.000Z"),
      }),
    ).toThrow();
  });
  it("rejects absent native metadata and stale retention", () => {
    const { nativePreview, ...incomplete } = binding();
    void nativePreview;
    expect(() =>
      nativeWorkingPreview({
        appId: selection.appId,
        baseRoute: "/spend-review",
        bindings: incomplete,
        landingPath: "/",
      }),
    ).toThrow();
    expect(() =>
      nativeWorkingPreview({
        appId: selection.appId,
        baseRoute: "/spend-review",
        bindings: binding(),
        landingPath: "/",
        now: Date.parse(plan.retention.expiresAt),
      }),
    ).toThrow();
  });
  it.each(["publicOrigin", "planDigest", "operationRef", "expiresAt"] as const)(
    "rejects native projection %s mismatch",
    (key) => {
      const bindings = binding();
      bindings.nativePreview[key] = key === "expiresAt" ? "2028-01-01T00:00:00.000Z" : "wrong";
      expect(() =>
        nativeWorkingPreview({
          appId: selection.appId,
          baseRoute: "/spend-review",
          bindings,
          landingPath: "/",
          now: Date.parse("2026-10-09T12:01:00.000Z"),
        }),
      ).toThrow();
    },
  );
  it.each(["operationRef", "projectId", "repoId", "branch", "readyState"] as const)(
    "rejects candidate %s mismatch",
    (key) => {
      const bindings = binding();
      bindings.nativePreview.app[key] = "wrong";
      expect(() =>
        nativeWorkingPreview({
          appId: selection.appId,
          baseRoute: "/spend-review",
          bindings,
          landingPath: "/",
          now: Date.parse("2026-10-09T12:01:00.000Z"),
        }),
      ).toThrow();
    },
  );
});
