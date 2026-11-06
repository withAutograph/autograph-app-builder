import { describe, expect, it } from "vitest";
import {
  assertOwnedAppAuthRuntimeScope,
  assertOwnedAppProductionEnvironment,
  ownedAppPublicEnvironmentManifest,
  ownedAppPublicEnvironmentKeys,
} from "./owned-app-auth-environment";
import { plan } from "./public-release-test-fixture";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_installer`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const fixture = () => {
  const authResource = resource("auth_app");
  const appResource = resource("invoice_app");
  const profile: NonNullable<HostedOperatorSourceConfiguration["standardRuntime"]> = {
    appSpecDigest: "e".repeat(64),
    authOwnership: { kind: "dedicated-app-development", resource: { ...authResource } },
    capturedReleaseId: "release-current",
    productionDatabaseIdentity: "ep-customer-production.neon.tech/auth",
    profileId: "reviewed-isolated-profile",
    provisioningDigest: plan.project.provisioningDigest,
    provisioningRequestId: plan.project.provisioningRequestId,
    publicRealmWorkload: {
      audience: "https://vercel.com/team",
      environment: "production",
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "owned-project",
      subject: "explicit-production-workload",
    },
  };
  return {
    appId: plan.selection.appId,
    appResource,
    authResource,
    bindings: {
      appDatabase: {
        runtimeUrl:
          "postgresql://invoice_app_runtime:private-app@ep-dedicated-development.neon.tech/invoice_app?sslmode=verify-full",
      },
      authDatabase: {
        runtimeUrl:
          "postgresql://auth_app_runtime:private-auth@ep-dedicated-development.neon.tech/auth_app?sslmode=verify-full",
      },
    },
    neon: {
      branchId: "dedicated-branch",
      endpoint: "ep-dedicated-development.neon.tech",
      projectId: "dedicated-project",
      source: "synthetic-only" as const,
    },
    profile,
    publicOrigin: plan.publicOrigin,
  };
};

describe("owned application Auth project boundary", () => {
  it("admits its exact dedicated development Auth backend without claiming per-service secret isolation", () => {
    const input = fixture();
    const scope = assertOwnedAppAuthRuntimeScope(input);
    expect(scope).toMatchObject({
      authResource: input.authResource,
      boundary: "owned-app-project",
      profileId: input.profile.profileId,
      providerEnvironment: "development",
    });
    expect(JSON.stringify(scope)).not.toContain("private-auth");
    expect(JSON.stringify(scope)).not.toContain("private-app");
  });
  it.each([
    "shared-auth",
    "same-database",
    "same-role",
    "migrator-url",
    "production",
    "pooled-production",
    "insecure-tls",
    "default-admin",
  ])("denies %s before values are published", (failure) => {
    const input = fixture();
    if (failure === "shared-auth") {
      input.profile.authOwnership.resource.database = "shared_customer_auth";
    }
    if (failure === "same-database") {
      input.appResource.database = input.authResource.database;
    }
    if (failure === "same-role") {
      input.appResource.runtimeRole = input.authResource.migratorRole;
    }
    if (failure === "migrator-url") {
      input.bindings.authDatabase.runtimeUrl = input.bindings.authDatabase.runtimeUrl.replace(
        "auth_app_runtime",
        "auth_app_installer",
      );
    }
    if (failure === "production") {
      input.profile.productionDatabaseIdentity = `${input.neon.endpoint}/different_database`;
    }
    if (failure === "pooled-production") {
      input.profile.productionDatabaseIdentity =
        "ep-dedicated-development-pooler.neon.tech/different_database";
    }
    if (failure === "insecure-tls") {
      input.bindings.authDatabase.runtimeUrl = input.bindings.authDatabase.runtimeUrl.replace(
        "verify-full",
        "require",
      );
    }
    if (failure === "default-admin") {
      input.bindings.appDatabase.runtimeUrl = input.bindings.appDatabase.runtimeUrl.replace(
        "invoice_app_runtime",
        "neondb_owner",
      );
    }
    expect(() => assertOwnedAppAuthRuntimeScope(input)).toThrow(
      "owned_app_auth_environment_unavailable",
    );
  });
  it("keeps the entire allowed runtime key set explicit and retained evidence hash-only", () => {
    const values = Object.fromEntries(
      ownedAppPublicEnvironmentKeys(plan.selection.appId).map((key) => [
        key,
        `private-value-${key}`,
      ]),
    );
    const environment = ownedAppPublicEnvironmentManifest(plan.selection.appId, values);
    expect(environment).toHaveLength(15);
    expect(JSON.stringify(environment)).not.toContain("private-value");
    const selected = { ...plan, environment };
    expect(() => {
      assertOwnedAppProductionEnvironment(selected, Object.keys(values));
    }).not.toThrow();
    expect(() =>
      ownedAppPublicEnvironmentManifest(plan.selection.appId, {
        ...values,
        NEON_API_KEY: "private-admin",
      }),
    ).toThrow();
    const missing = { ...values };
    delete missing.BETTER_AUTH_SECRET;
    expect(() => ownedAppPublicEnvironmentManifest(plan.selection.appId, missing)).toThrow();
  });
  it.each([
    "DATABASE_URL",
    "OTHER_APP_DATABASE_URL",
    "VERCEL_TOKEN",
    "NEON_API_KEY",
    "AUTH_MIGRATION_URL",
    "PGPASSWORD",
    "PLATFORM_OPERATOR_TOKEN",
  ])("never exempts project credential %s", (key) => {
    const selected = {
      ...plan,
      environment: ownedAppPublicEnvironmentKeys(plan.selection.appId).map((name) => ({
        key: name,
        sha256: "d".repeat(64),
      })),
    };
    expect(() => {
      assertOwnedAppProductionEnvironment(selected, [key]);
    }).toThrow();
  });
  it("does not admit a recognized Auth key without this frozen plan's exact hash binding", () => {
    const selected = {
      ...plan,
      environment: [{ key: "INVOICE_APP_DATABASE_URL", sha256: "d".repeat(64) }],
    };
    expect(() => {
      assertOwnedAppProductionEnvironment(selected, ["BETTER_AUTH_SECRET"]);
    }).toThrow();
    expect(() => {
      assertOwnedAppProductionEnvironment(selected, ["APP_FEATURE_ENABLED"]);
    }).not.toThrow();
  });
});
