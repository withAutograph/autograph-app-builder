/* oxlint-disable eslint/require-await -- These pre-launch ports never create a VM or contact a provider. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedOperatorError } from "./hosted-operator-contract";
import { createProductionAuthSchemaProposal } from "./production-auth-schema-rollout-proposal";
import { profile } from "./production-auth-schema-rollout.test-fixture";

const migrationUrl =
  "postgresql://auth_owner:synthetic-private-password@ep-auth.neon.tech/auth?sslmode=require";
afterEach(() => vi.restoreAllMocks());

describe("Production Auth proposal failures before a VM exists", () => {
  it.each([
    "migration_binding_read",
    "migration_binding_validation",
    "sandbox_oidc",
    "sandbox_create",
  ] as const)("attributes %s without logging connection or token data", async (phase) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = new HostedOperatorError("operator_unavailable", {
      cause: "synthetic-private-provider-details",
    });
    const readMigrationUrl = vi.fn(async () => {
      if (phase === "migration_binding_read") {
        throw original;
      }
      return phase === "migration_binding_validation"
        ? migrationUrl.replace("auth_owner", "wrong_owner")
        : migrationUrl;
    });
    const getOidc = vi.fn(async () => {
      if (phase === "sandbox_oidc") {
        throw original;
      }
      return "synthetic-private-oidc";
    });
    const createSandbox = vi.fn(async () => {
      throw original;
    });
    await expect(
      createProductionAuthSchemaProposal({ getOidc, createSandbox })({
        profile,
        readMigrationUrl,
        assertCurrent: async () => {},
      }),
    ).rejects.toMatchObject({
      code: phase === "migration_binding_validation" ? "resource_mismatch" : "operator_unavailable",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"phase":"${phase}"`));
    if (phase.startsWith("migration_binding")) {
      expect(getOidc).not.toHaveBeenCalled();
    }
    expect(createSandbox).toHaveBeenCalledTimes(phase === "sandbox_create" ? 1 : 0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(profile.resource.hostname);
  });
});
