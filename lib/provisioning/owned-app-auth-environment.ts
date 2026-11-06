import { appIntegrationOptionalEnvironmentKeys } from "./app-integration-release-contract";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { PublicReleasePlan } from "./public-release-contract";

type Resource = HostedOperatorSourceConfiguration["authDatabase"];
type Profile = NonNullable<HostedOperatorSourceConfiguration["standardRuntime"]>;
const unavailable = () => new Error("owned_app_auth_environment_unavailable");
const normalizeHost = (hostname: string) => hostname.replace(/-pooler(?=\.)/u, "");
const runtimeUrl = (text: string, resource: Resource, hostname: string) => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw unavailable();
  }
  const valid = [
    ["postgres:", "postgresql:"].includes(url.protocol),
    normalizeHost(url.hostname) === normalizeHost(hostname),
    url.hostname.endsWith(".neon.tech"),
    url.port === "" || url.port === "5432",
    decodeURIComponent(url.username) === resource.runtimeRole,
    decodeURIComponent(url.pathname.slice(1)) === resource.database,
    url.password !== "",
    url.hash === "",
    url.searchParams.get("sslmode") === "verify-full",
    !["postgres", "neondb_owner"].includes(resource.runtimeRole),
  ].every(Boolean);
  if (!valid) {
    throw unavailable();
  }
};

/**
 * These facts must come from the current owner-scoped approved runtime and its
 * private credential reader. The profile explicitly owns this app's dedicated
 * development Auth backend; no service-level secret isolation is claimed.
 */
export const assertOwnedAppAuthRuntimeScope = (input: {
  appId: string;
  appResource: Resource;
  authResource: Resource;
  neon: Pick<HostedOperatorPlan["neon"], "endpoint" | "projectId" | "branchId" | "source">;
  profile: Profile;
  publicOrigin: string;
  bindings: { appDatabase: { runtimeUrl: string }; authDatabase: { runtimeUrl: string } };
}) => {
  const { appResource, authResource, profile } = input;
  const publicUrl = new URL(input.publicOrigin);
  const production = /^(?<host>[a-z0-9.-]+\.neon\.tech)\/[a-z][a-z0-9_]*$/u.exec(
    profile.productionDatabaseIdentity,
  );
  const valid = [
    profile.authOwnership.kind === "dedicated-app-development",
    isDeepStrictEqual(profile.authOwnership.resource, authResource),
    input.neon.source === "synthetic-only",
    appResource.database !== authResource.database,
    new Set([
      appResource.runtimeRole,
      appResource.migratorRole,
      authResource.runtimeRole,
      authResource.migratorRole,
    ]).size === 4,
    publicUrl.protocol === "https:",
    publicUrl.origin === input.publicOrigin,
    production !== null,
    normalizeHost(production?.groups?.host ?? "") !== normalizeHost(input.neon.endpoint),
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.appId),
  ].every(Boolean);
  if (!valid) {
    throw unavailable();
  }
  runtimeUrl(input.bindings.appDatabase.runtimeUrl, appResource, input.neon.endpoint);
  runtimeUrl(input.bindings.authDatabase.runtimeUrl, authResource, input.neon.endpoint);
  return {
    appId: input.appId,
    appResource: { ...appResource },
    authResource: { ...authResource },
    boundary: "owned-app-project" as const,
    profileId: profile.profileId,
    providerEnvironment: "development" as const,
    publicOrigin: input.publicOrigin,
  };
};

export const ownedAppPublicEnvironmentKeys = (appId: string) => [
  `${appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`,
  "PLATFORM_AUTH_DATABASE_URL",
  "AUTH_DATABASE_RESOURCE",
  "BETTER_AUTH_SECRET",
  "PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY",
  "PLATFORM_GATEWAY_IDENTITY_KEY_ID",
  "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
  "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
  "BETTER_AUTH_URL",
  "PLATFORM_PUBLIC_ORIGIN",
  "PLATFORM_ORIGIN",
  "PLATFORM_AUTH_TRUSTED_ORIGINS",
  "PLATFORM_JWKS_URL",
  "AUTH_PRODUCTION_DATABASE_IDENTITY",
  "PLATFORM_AUTH_DEPLOYMENT_PROFILE",
];
const sensitiveProjectKey = (key: string) =>
  [
    key.includes("DATABASE_URL"),
    key.startsWith("POSTGRES_"),
    ["PGPASSWORD", "PGUSER", "PGHOST", "PGHOST_UNPOOLED", "PGDATABASE"].includes(key),
    /(?:MIGRAT(?:OR|ION)|MAINTENANCE|ADMIN|ROOT)_(?:URL|PASSWORD|TOKEN|KEY)$/u.test(key),
    /(?:SECRET|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|CONTROL_KEY|OPERATOR_TOKEN)$/u.test(key),
    [
      "VERCEL_TOKEN",
      "VERCEL_OIDC_TOKEN",
      "NEON_API_KEY",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_APP_NAME",
      ...appIntegrationOptionalEnvironmentKeys,
    ].includes(key),
  ].some(Boolean);

/** Call before binding/reconciliation/readiness, using actual Production-scoped provider keys. */
export const assertOwnedAppProductionEnvironment = (
  plan: PublicReleasePlan,
  productionKeys: readonly string[],
) => {
  const allowed = new Set(ownedAppPublicEnvironmentKeys(plan.selection.appId));
  if (plan.integrationCapability !== undefined) {
    for (const key of appIntegrationOptionalEnvironmentKeys) {
      allowed.add(key);
    }
  }
  const planned = new Set(plan.environment.map((entry) => entry.key));
  const retained = new Set<string>(plan.retainedOptionalBindings?.map((entry) => entry.key));
  for (const key of retained) {
    allowed.add(key);
  }

  if (
    plan.environment.some((entry) => !allowed.has(entry.key)) ||
    productionKeys.some(
      (key) =>
        sensitiveProjectKey(key) &&
        (!allowed.has(key) || (!planned.has(key) && !retained.has(key))),
    )
  ) {
    throw unavailable();
  }
};

/** Validate the entire private factory result before sealing it, including exact allowed key hashes. */
export const ownedAppPublicEnvironmentManifest = (
  appId: string,
  values: Readonly<Record<string, string>>,
) => {
  const allowed = new Set(ownedAppPublicEnvironmentKeys(appId));
  const keys = Object.keys(values);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw unavailable();
  }
  return keys
    .toSorted()
    .map((key) => ({ key, sha256: createHash("sha256").update(values[key]).digest("hex") }));
};

/** A separately approved attachment admits exactly its two hashed configuration keys. Auth remains fifteen keys. */
export const ownedAppReleaseEnvironmentManifest = (
  appId: string,
  values: Readonly<Record<string, string>>,
  integration?: PublicReleasePlan["integrationCapability"],
) => {
  if (integration === undefined) {
    return ownedAppPublicEnvironmentManifest(appId, values);
  }
  const auth = Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => !new Set<string>(appIntegrationOptionalEnvironmentKeys).has(key),
    ),
  );
  const manifest = ownedAppPublicEnvironmentManifest(appId, auth);
  const capability = values.APP_INTEGRATIONS_CAPABILITY;
  const configuration = values.APP_INTEGRATIONS_RUNTIME_CONFIGURATION;
  if (capability === undefined || configuration === undefined) {
    throw unavailable();
  }
  const valid = [
    Object.keys(values).length === manifest.length + 2,
    capability === JSON.stringify(integration.capability),
    createHash("sha256").update(configuration).digest("hex") ===
      integration.capability.privateConfiguration.sha256,
  ];
  if (valid.includes(false)) {
    throw unavailable();
  }
  return [
    ...manifest,
    ...appIntegrationOptionalEnvironmentKeys.map((key) => ({
      key,
      sha256: createHash("sha256").update(values[key]).digest("hex"),
    })),
  ].toSorted((a, b) => a.key.localeCompare(b.key));
};
