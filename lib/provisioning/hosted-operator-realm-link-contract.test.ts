import { describe, expect, it } from "vitest";
import {
  hostedOperatorPlanSchema,
  hostedOperatorRecordSchema,
  operatorPlanDigest,
  operatorRealmIdentityLinkSchema,
  projectPendingRealmIdentityLink,
} from "./hosted-operator-contract";
import { operatorArtifactReferenceSchema } from "./hosted-operator-artifact-store";

const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context",
  cost: { class: "independent-service", description: "fixture", owner: "fixture" },
  deploymentBoundary: {
    app: {
      branch: "feature",
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: "prj_app",
    },
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "owner",
      workspaceId: "workspace",
    },
    gateway: {
      branch: "feature",
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    teamId: "team_1",
    verification: {
      gatewayOrigin: "https://gateway.example",
      jwksUrl: "https://gateway.example/_platform/jwks.json",
      publicOrigin: "https://public.example",
    },
  },
  effects: [
    { description: "resources", id: "resources", kind: "resources" },
    { description: "install", id: "install", kind: "install" },
    { description: "access", id: "access", kind: "access" },
    { description: "bind", id: "bind", kind: "bindings" },
    { description: "Bind owned Gateway Auth.", id: "gateway-bindings", kind: "gateway-bindings" },
  ],
  gatewayBindings: {
    authBrowserOrigin: "https://auth.example.test",
    builderCallbackOrigin: "https://builder.example.test",
    catalogAppIds: ["spend-review"],
    operatorOrigin: "https://operator.example",
    sourceWorkload: {
      audience: "https://vercel.com/fixture",
      environment: "preview",
      issuer: "https://oidc.vercel.com/fixture",
      ownerId: "team",
      projectId: "prj_gateway",
      subject: "observed-fixture",
    },
  },
  installer: { reference: "installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private",
    endpoint: "ep-fixture.neon.tech",
    projectId: "project",
    source: "synthetic-only",
  },
  publicGateway: { branch: "feature", origin: "https://public.example", projectId: "prj_gateway" },
  release: { artifactRef: "release", id: "v19", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "fixture" },
  selection: {
    appId: "spend-review",
    branch: "feature",
    environment: "preview",
    projectId: "prj_app",
    sessionId: "public-session",
  },
  version: 1,
});
const operationRef = "00000000-0000-4000-8000-000000000001";
const link = {
  audience: "https://operator.example",
  authResourceId: "auth-resource",
  bootstrapPlanDigest: "c".repeat(64),
  browserOrigin: "https://auth.example.test",
  endpointOrigin: "https://gateway.example",
  expiresAt: "2027-01-01T00:00:00Z",
  issuer: "https://public.example",
  nonceSha256: "d".repeat(64),
  organizationId: null,
  ownerSessionId: "public-session",
};
const record = () => ({
  identityLink: link,
  mode: "protected-operator-v1",
  operationRef,
  plan,
  planDigest: operatorPlanDigest(plan),
  receipts: [],
});

describe("owner-bound private Realm identity link contract", () => {
  it("projects a refined valid pending link without invoking Zod omit or exposing encrypted nonce", () => {
    const pending = operatorRealmIdentityLinkSchema.parse({
      ...link,
      sealedNonce: { encryptedToken: "cipher", keyVersion: "v1", tokenIv: "iv", tokenTag: "tag" },
    });
    expect(projectPendingRealmIdentityLink(pending)).toEqual(link);
  });
  it("keeps source signer issuer distinct from actual endpoint and has no app grants", () => {
    expect(hostedOperatorRecordSchema.parse(record()).identityLink).toEqual(link);
    expect(
      operatorRealmIdentityLinkSchema.safeParse({ ...link, appRoles: ["owner"] }).success,
    ).toBe(false);
  });
  it.each(["authResourceId", "ownerSessionId", "issuer", "endpointOrigin"] as const)(
    "rejects cross-scope %s",
    (field) => {
      expect(
        hostedOperatorRecordSchema.safeParse({
          ...record(),
          identityLink: {
            ...link,
            [field]:
              field.endsWith("Origin") || field === "issuer"
                ? "https://foreign.example"
                : "foreign",
          },
        }).success,
      ).toBe(false);
    },
  );
  it("requires proof reference and digest atomically with consumed nonce", () => {
    expect(
      operatorRealmIdentityLinkSchema.safeParse({ ...link, consumedAt: "2026-10-08T00:00:00Z" })
        .success,
    ).toBe(false);
    expect(
      operatorRealmIdentityLinkSchema.safeParse({
        ...link,
        proofRef: "private-proof",
        proofSha256: "e".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      operatorRealmIdentityLinkSchema.parse({
        ...link,
        consumedAt: "2026-10-08T00:00:00Z",
        proofRef: "private-proof",
        proofSha256: "e".repeat(64),
      }).proofRef,
    ).toBe("private-proof");
  });
  it("uses existing private artifact namespace for a bounded captured proof", () => {
    expect(
      operatorArtifactReferenceSchema.parse(
        `_protected-operator/artifacts/realm-identity-proof/spend-review/${"f".repeat(64)}`,
      ),
    ).toContain("realm-identity-proof");
  });
});
