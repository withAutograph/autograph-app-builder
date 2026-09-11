import { describe, expect, it } from "vitest";

import { resolveBetterAuthInfrastructure } from "./better-auth-infrastructure";

describe("resolveBetterAuthInfrastructure", () => {
  it("stays disabled without an explicit activation value", () => {
    const result = resolveBetterAuthInfrastructure({
      environment: {},
      organizationAuthorityReady: true,
    });

    expect(result.plugins).toEqual([]);
    expect(result.summary).toEqual({
      enabled: false,
      plan: null,
      organizationAuthorityReady: true,
    });
  });

  it("enables only the Starter dashboard after organization authority is ready", () => {
    const result = resolveBetterAuthInfrastructure({
      environment: {
        BETTER_AUTH_INFRASTRUCTURE: "starter-dashboard-v1",
        BETTER_AUTH_API_KEY: "test-infrastructure-key",
      },
      organizationAuthorityReady: true,
    });

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.id).toBe("dash");
    expect(result.summary).toEqual({
      enabled: true,
      plan: "starter",
      organizationAuthorityReady: true,
    });
    expect(JSON.stringify(result.summary)).not.toContain(
      "test-infrastructure-key",
    );
  });

  it("fails closed before the organization migration is verified", () => {
    expect(() =>
      resolveBetterAuthInfrastructure({
        environment: {
          BETTER_AUTH_INFRASTRUCTURE: "starter-dashboard-v1",
          BETTER_AUTH_API_KEY: "test-infrastructure-key",
        },
        organizationAuthorityReady: false,
      }),
    ).toThrow("organization authority migration is verified");
  });

  it("rejects missing credentials and unknown activation values", () => {
    expect(() =>
      resolveBetterAuthInfrastructure({
        environment: {
          BETTER_AUTH_INFRASTRUCTURE: "starter-dashboard-v1",
        },
        organizationAuthorityReady: true,
      }),
    ).toThrow("BETTER_AUTH_API_KEY is required");

    expect(() =>
      resolveBetterAuthInfrastructure({
        environment: {
          BETTER_AUTH_INFRASTRUCTURE: "enabled",
          BETTER_AUTH_API_KEY: "test-infrastructure-key",
        },
        organizationAuthorityReady: true,
      }),
    ).toThrow("must be exactly starter-dashboard-v1");
  });
});
