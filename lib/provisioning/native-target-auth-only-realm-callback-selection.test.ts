/* oxlint-disable eslint/require-await -- Callback selection uses fake private receipt ports. */
import { expect, it, vi } from "vitest";
import { selectNativeTargetAuthOnlyRealmCallback } from "./native-target-auth-only-realm-callback-selection";
import type { NativeTargetAuthOnlyRealmCallbackPorts } from "./native-target-auth-only-realm-callback-selection";
import { nativeTargetAuthOnlyOwnerLinkBindingSchema } from "./native-target-auth-only-owner-link";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

const builderOrigin = "https://builder.example";
const authority = {
  audience: `${builderOrigin}/mcp`,
  issuer: `${builderOrigin}/api/auth`,
  ownerUserId: "canonical-owner",
  workspaceId: "owned-workspace",
};
const operationRef = "44444444-4444-4444-a444-444444444444";
const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse({
  audience: "https://operator-preview.example",
  authOnlyPlanDigest: "a".repeat(64),
  authResourceId: "isolated-auth",
  authority,
  bootstrapResource: {
    database: "pilot_auth",
    environment: "preview",
    hostname: "ep-pilot.neon.tech",
    migratorRole: "pilot_migrator",
    neon: { branchId: "br-pilot", projectId: "neon-pilot" },
    port: 5432,
    runtimeRole: "pilot_runtime",
    schema: "public",
    version: 1,
  },
  browserOrigin: "https://auth-pilot.example",
  gateway: {
    branch: "isolated-gateway",
    deploymentId: "dpl-ready",
    operationRef,
    origin: "https://immutable-gateway.example",
    projectId: "prj-gateway",
    readyState: "READY",
    repoId: "repo-approved",
  },
  gatewayDeliveryPlanDigest: "c".repeat(64),
  issuer: "https://auth-pilot.example",
  operationRef,
  resourcePlanDigest: "b".repeat(64),
  sender: {
    audience: "https://vercel.com/owner",
    environment: "preview",
    issuer: "https://oidc.vercel.com/owner",
    ownerId: "team-owner",
    projectId: "prj-gateway",
    subject: "owner:owner:project:gateway:environment:preview",
  },
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
});
const ownerSessionId = binding.target.sessionId;
const nonceSha256 = "d".repeat(64);
const selector = { nonceSha256, ownerSessionId };
const pending = {
  binding,
  bootstrapResource: binding.bootstrapResource,
  jwksUrl: new URL("/_platform/jwks.json", binding.gateway.origin).href,
  link: {
    audience: binding.audience,
    authResourceId: binding.authResourceId,
    bootstrapPlanDigest: binding.resourcePlanDigest,
    browserOrigin: binding.browserOrigin,
    endpointOrigin: binding.gateway.origin,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    issuer: binding.issuer,
    nonceSha256,
    organizationId: null,
    ownerSessionId,
  },
  sender: binding.sender,
};
const configuration = {
  authDatabase: {
    database: binding.bootstrapResource.database,
    migratorRole: binding.bootstrapResource.migratorRole,
    resourceId: binding.authResourceId,
    runtimeRole: binding.bootstrapResource.runtimeRole,
  },
  builderCallbackOrigin: builderOrigin,
  gateway: {
    authBrowserOrigin: binding.browserOrigin,
    branch: binding.gateway.branch,
    environment: "preview",
    projectId: binding.gateway.projectId,
    publicOrigin: binding.issuer,
    workload: binding.sender,
  },
  nativeNeon: {
    scope: {
      hostname: binding.bootstrapResource.hostname,
      ...binding.bootstrapResource.neon,
    },
  },
  operator: { environment: "preview", origin: binding.audience },
  teamId: binding.target.scopeId,
} as HostedOperatorSourceConfiguration;
const context = {
  authority,
  ownerContext: operatorOwnerContextSchema.parse({
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: ownerSessionId,
    adapterSessionId: "saved-adapter",
    adapterGeneration: 1,
  }),
  target: binding.target,
};
const ready = {
  configuration,
  context,
  gateway: binding.gateway,
  readiness: {
    authOnlyPlanDigest: binding.authOnlyPlanDigest,
    authResourceId: binding.authResourceId,
    catalogFingerprint: "e".repeat(64),
    gatewayDeliveryPlanDigest: binding.gatewayDeliveryPlanDigest,
    resourcePlanDigest: binding.resourcePlanDigest,
  },
};
const fixture = () => ({
  ownerLink: {
    consume: vi.fn<NativeTargetAuthOnlyRealmCallbackPorts["ownerLink"]["consume"]>(),
    readPending: vi
      .fn<NativeTargetAuthOnlyRealmCallbackPorts["ownerLink"]["readPending"]>()
      .mockResolvedValue(pending),
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
    staging: { bootstrapResource: binding.bootstrapResource, jwksUrl: pending.jwksUrl },
  });
  expect(selected?.staging.link).not.toHaveProperty("sealedNonce");
  expect(ports.readReadyBinding).toHaveBeenCalledWith(binding);
  expect(ports.ownerLink.consume).not.toHaveBeenCalled();
});

it("falls back only for a true lookup miss and rejects missing live readiness for a matched row", async () => {
  const ports = fixture();
  ports.ownerLink.readPending.mockResolvedValueOnce();
  expect(
    await selectNativeTargetAuthOnlyRealmCallback(ports, selector, builderOrigin),
  ).toBeUndefined();
  expect(ports.readReadyBinding).not.toHaveBeenCalled();
  ports.readReadyBinding.mockResolvedValueOnce();
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
