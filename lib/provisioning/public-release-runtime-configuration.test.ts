import { describe, expect, it } from "vitest";
import { createFreshPublicAuthValues } from "./public-release-runtime-configuration";

const input = {
  publicOrigin: "https://app.example",
  appId: "invoice-app",
  authResource: {
    environment: "preview" as const,
    hostname: "ep-synthetic.aws.neon.tech",
    port: 5432 as const,
    database: "app_auth",
    schema: "public" as const,
    runtimeRole: "restricted_auth",
    migratorRole: "auth_migrator",
    neon: { projectId: "synthetic", branchId: "non-default" },
  },
  authRuntimeUrl:
    "postgresql://restricted_auth:private@ep-synthetic.aws.neon.tech/app_auth?sslmode=verify-full",
  productionDatabaseIdentity: "ep-production.aws.neon.tech/neondb",
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
    expect(JSON.parse(first.AUTH_DATABASE_RESOURCE)).toMatchObject({
      ...input.authResource,
    });
    expect(first).not.toHaveProperty("VERCEL_ENV");
    expect(first).not.toHaveProperty("PLATFORM_AUTH_COOKIE_DOMAIN");
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
