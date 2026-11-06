import { describe, expect, it } from "vitest";
import { publicRealmResourceSchema } from "./public-realm-enrollment";
import { createFreshPublicAuthValues } from "./public-release-runtime-configuration";

const input = {
  appId: "invoice-app",
  authResource: {
    database: "app_auth",
    environment: "preview" as const,
    hostname: "ep-synthetic.aws.neon.tech",
    migratorRole: "auth_migrator",
    neon: { branchId: "non-default", projectId: "synthetic" },
    port: 5432 as const,
    runtimeRole: "restricted_auth",
    schema: "public" as const,
  },
  authRuntimeUrl:
    "postgresql://restricted_auth:private@ep-synthetic.aws.neon.tech/app_auth?sslmode=verify-full",
  productionDatabaseIdentity: "ep-production.aws.neon.tech/neondb",
  publicOrigin: "https://app.example",
};
describe("fresh public app Auth configuration", () => {
  it("generates private per-app keys with exact public origins and an isolated resource profile", () => {
    const first = createFreshPublicAuthValues(input);
    const second = createFreshPublicAuthValues(input);
    expect(first.BETTER_AUTH_URL).toBe(input.publicOrigin);
    expect(first.PLATFORM_AUTH_TRUSTED_ORIGINS).toBe(input.publicOrigin);
    expect(first.PLATFORM_AUTH_DEPLOYMENT_PROFILE).toBe("isolated-development");
    expect(first.BETTER_AUTH_SECRET).toHaveLength(43);
    expect(first.BETTER_AUTH_SECRET).not.toBe(second.BETTER_AUTH_SECRET);
    expect(first).not.toHaveProperty("BETTER_AUTH_API_KEY");
    expect(publicRealmResourceSchema.parse(JSON.parse(first.AUTH_DATABASE_RESOURCE))).toEqual({
      version: 1,
      ...input.authResource,
    });
    expect(first).not.toHaveProperty("VERCEL_ENV");
    expect(first).not.toHaveProperty("PLATFORM_AUTH_COOKIE_DOMAIN");
  });
  it("retains the explicitly isolated resource classification where already enrolled", () => {
    const authResource = { ...input.authResource, environment: "isolated-development" as const };
    const values = createFreshPublicAuthValues({ ...input, authResource });
    expect(publicRealmResourceSchema.parse(JSON.parse(values.AUTH_DATABASE_RESOURCE))).toEqual({
      version: 1,
      ...authResource,
    });
  });

  it.each([
    { productionDatabaseIdentity: "ep-synthetic-pooler.aws.neon.tech/other_database" },
    { productionDatabaseIdentity: "" },
    {
      authRuntimeUrl:
        "postgresql://postgres:private@ep-synthetic.aws.neon.tech/app_auth?sslmode=verify-full",
    },
    {
      authRuntimeUrl:
        "postgresql://restricted_auth:private@ep-synthetic.aws.neon.tech/neondb?sslmode=verify-full",
    },
    {
      authRuntimeUrl:
        "postgresql://restricted_auth:private@ep-synthetic.aws.neon.tech/app_auth?sslmode=disable",
    },
    { publicOrigin: "https://app.example/api/auth" },
  ])("denies unsafe resource or public-origin substitution", (change) => {
    expect(() => createFreshPublicAuthValues({ ...input, ...change })).toThrow();
  });
});
