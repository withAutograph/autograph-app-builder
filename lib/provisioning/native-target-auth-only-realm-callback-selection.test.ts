/* oxlint-disable eslint/require-await -- Callback selection uses fake private receipt ports. */
import { expect, it, vi } from "vitest";
import { selectNativeTargetAuthOnlyRealmCallback } from "./native-target-auth-only-realm-callback-selection";
import type { NativeTargetAuthOnlyRealmCallbackPorts } from "./native-target-auth-only-realm-callback-selection";
import { nativeTargetAuthOnlyOwnerLinkBindingSchema } from "./native-target-auth-only-owner-link";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

const builderOrigin = "https://builder.example";
const authority = {
  issuer: `${builderOrigin}/api/auth`,
  audience: `${builderOrigin}/mcp`,
  workspaceId: "owned-workspace",
  ownerUserId: "canonical-owner",
};
const operationRef = "44444444-4444-4444-a444-444444444444";
const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse({
  authority,
  target: {
    appId: "signup-pilot",
    branch: "pilot",
    environment: "preview",
    installationId: "icfg-owner",
    projectId: "prj-app",
    scopeId: "team-owner",
    scopeType: "team",
    sessionId: "saved-session",
  },
  operationRef,
  authOnlyPlanDigest: "a".repeat(64),
  resourcePlanDigest: "b".repeat(64),
  gatewayDeliveryPlanDigest: "c".repeat(64),
  gateway: {
    branch: "isolated-gateway",
    deploymentId: "dpl-ready",
    operationRef,
    origin: "https://immutable-gateway.example",
    projectId: "prj-gateway",
    readyState: "READY",
    repoId: "repo-approved",
  },
  sender: {
    issuer: "https://oidc.vercel.com/owner",
    audience: "https://vercel.com/owner",
    projectId: "prj-gateway",
    ownerId: "team-owner",
    subject: "owner:owner:project:gateway:environment:preview",
    environment: "preview",
  },
  browserOrigin: "https://auth-pilot.example",
  issuer: "https://auth-pilot.example",
  audience: "https://operator-preview.example",
  authResourceId: "isolated-auth",
  bootstrapResource: {
    environment: "preview",
    port: 5432,
    schema: "public",
    version: 1,
    database: "pilot_auth",
    hostname: "ep-pilot.neon.tech",
    migratorRole: "pilot_migrator",
    runtimeRole: "pilot_runtime",
    neon: { branchId: "br-pilot", projectId: "neon-pilot" },
  },
});
const ownerSessionId = binding.target.sessionId;
const nonceSha256 = "d".repeat(64);
const selector = { ownerSessionId, nonceSha256 };
const pending = {
  binding,
  link: {
    audience: binding.audience,
    issuer: binding.issuer,
    authResourceId: binding.authResourceId,
    browserOrigin: binding.browserOrigin,
    endpointOrigin: binding.gateway.origin,
    bootstrapPlanDigest: binding.resourcePlanDigest,
    ownerSessionId,
    nonceSha256,
    organizationId: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  bootstrapResource: binding.bootstrapResource,
  jwksUrl: new URL("/_platform/jwks.json", binding.gateway.origin).href,
  sender: binding.sender,
};
const configuration = {
  builderCallbackOrigin: builderOrigin,
  teamId: binding.target.scopeId,
  operator: { origin: binding.audience, environment: "preview" },
  gateway: {
    environment: "preview",
    projectId: binding.gateway.projectId,
    branch: binding.gateway.branch,
    authBrowserOrigin: binding.browserOrigin,
    publicOrigin: binding.issuer,
    workload: binding.sender,
  },
  authDatabase: {
    resourceId: binding.authResourceId,
    database: binding.bootstrapResource.database,
    runtimeRole: binding.bootstrapResource.runtimeRole,
    migratorRole: binding.bootstrapResource.migratorRole,
  },
  nativeNeon: {
    scope: {
      hostname: binding.bootstrapResource.hostname,
      ...binding.bootstrapResource.neon,
    },
  },
} as HostedOperatorSourceConfiguration;
const context = {
  authority,
  target: binding.target,
  ownerContext: operatorOwnerContextSchema.parse({
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: ownerSessionId,
    adapterSessionId: "saved-adapter",
    adapterGeneration: 1,
  }),
};
const ready = {
  context,
  configuration,
  gateway: binding.gateway,
  readiness: {
    authOnlyPlanDigest: binding.authOnlyPlanDigest,
    resourcePlanDigest: binding.resourcePlanDigest,
    gatewayDeliveryPlanDigest: binding.gatewayDeliveryPlanDigest,
    authResourceId: binding.authResourceId,
    catalogFingerprint: "e".repeat(64),
  },
};
const fixture = () => ({
  ownerLink: {
    readPending: vi
      .fn<NativeTargetAuthOnlyRealmCallbackPorts["ownerLink"]["readPending"]>()
      .mockResolvedValue(pending),
    consume: vi.fn<NativeTargetAuthOnlyRealmCallbackPorts["ownerLink"]["consume"]>(),
  },
  readReadyBinding: vi
    .fn<NativeTargetAuthOnlyRealmCallbackPorts["readReadyBinding"]>()
    .mockResolvedValue(ready),
});

it("uses the authenticated retained Auth-only READY binding for the same saved session", async () => {
  const ports = fixture();
  const selected = await selectNativeTargetAuthOnlyRealmCallback(
    ports,
    { ...selector, authority },
    builderOrigin,
  );
  expect(selected).toMatchObject({
    binding,
    context,
    staging: { jwksUrl: pending.jwksUrl, bootstrapResource: binding.bootstrapResource },
  });
  expect(selected?.staging.link).not.toHaveProperty("sealedNonce");
  expect(ports.readReadyBinding).toHaveBeenCalledWith(binding);
  expect(ports.ownerLink.consume).not.toHaveBeenCalled();
});

it("falls back only for a true lookup miss and rejects missing live readiness for a matched row", async () => {
  const ports = fixture();
  ports.ownerLink.readPending.mockResolvedValueOnce(undefined);
  expect(
    await selectNativeTargetAuthOnlyRealmCallback(ports, selector, builderOrigin),
  ).toBeUndefined();
  expect(ports.readReadyBinding).not.toHaveBeenCalled();
  ports.readReadyBinding.mockResolvedValueOnce(undefined);
  await expect(
    selectNativeTargetAuthOnlyRealmCallback(ports, selector, builderOrigin),
  ).rejects.toThrow("auth_identity_required");
});

it.each([
  ["Gateway replacement", { ...ready, gateway: { ...ready.gateway, deploymentId: "dpl-foreign" } }],
  [
    "different owner",
    {
      ...ready,
      context: { ...context, authority: { ...authority, ownerUserId: "foreign-owner" } },
    },
  ],
  [
    "wrong resource",
    { ...ready, readiness: { ...ready.readiness, authResourceId: "shared-auth" } },
  ],
  [
    "stale approved delivery",
    { ...ready, readiness: { ...ready.readiness, gatewayDeliveryPlanDigest: "f".repeat(64) } },
  ],
  [
    "foreign issuer",
    {
      ...ready,
      configuration: {
        ...configuration,
        gateway: { ...configuration.gateway, publicOrigin: "https://other.example" },
      },
    },
  ],
  [
    "wrong selected resource profile",
    {
      ...ready,
      configuration: {
        ...configuration,
        nativeNeon: {
          ...configuration.nativeNeon,
          scope: { ...configuration.nativeNeon.scope, hostname: "foreign.neon.tech" },
        },
      },
    },
  ],
] as const)("rejects %s even when the nonce hash matches", async (_label, changed) => {
  const ports = fixture();
  ports.readReadyBinding.mockResolvedValue(changed);
  await expect(
    selectNativeTargetAuthOnlyRealmCallback(ports, selector, builderOrigin),
  ).rejects.toThrow("auth_identity_required");
});

it("rejects a mismatched canonical browser authority or Realm JWKS URL", async () => {
  const ports = fixture();
  await expect(
    selectNativeTargetAuthOnlyRealmCallback(
      ports,
      {
        ...selector,
        authority: { ...authority, workspaceId: "foreign-workspace" },
      },
      builderOrigin,
    ),
  ).rejects.toThrow("auth_identity_required");
  expect(ports.readReadyBinding).not.toHaveBeenCalled();
  ports.ownerLink.readPending.mockResolvedValue({
    ...pending,
    jwksUrl: "https://other.example/_platform/jwks.json",
  });
  await expect(
    selectNativeTargetAuthOnlyRealmCallback(ports, selector, builderOrigin),
  ).rejects.toThrow("auth_identity_required");
});

it("preserves canonical Stop denial without retrying the legacy lookup", async () => {
  const ports = fixture();
  ports.readReadyBinding.mockRejectedValue(new Error("saved session stopped"));
  await expect(
    selectNativeTargetAuthOnlyRealmCallback(ports, selector, builderOrigin),
  ).rejects.toThrow("saved session stopped");
});
