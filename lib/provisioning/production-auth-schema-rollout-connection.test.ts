import { describe, expect, it } from "vitest";
import { normalizeProductionAuthMigrationUrl } from "./production-auth-schema-rollout-connection";
import { assertAuthProposalMigrationUrl } from "./hosted-operator-auth-proposal";

const resource = {
  hostname: "ep-auth.neon.tech",
  port: 5432,
  database: "platform_auth",
  migratorRole: "platform_auth_owner",
} as const;
const original =
  "postgresql://platform_auth_owner:synthetic%2Fpassword%40with%3Aencoding@ep-auth.neon.tech:5432/platform_auth?channel_binding=require&sslmode=require";

describe("existing Production Auth migration binding TLS", () => {
  it("strengthens require before the unchanged strict assertion while preserving credential and target", () => {
    expect(() => {
      assertAuthProposalMigrationUrl(original, resource);
    }).toThrow();
    const normalized = normalizeProductionAuthMigrationUrl(original, resource);
    const before = new URL(original);
    const after = new URL(normalized);
    for (const key of [
      "protocol",
      "username",
      "password",
      "hostname",
      "port",
      "pathname",
    ] as const) {
      expect(after[key]).toBe(before[key]);
    }
    expect(after.searchParams.get("channel_binding")).toBe("require");
    expect(after.searchParams.getAll("sslmode")).toEqual(["verify-full"]);
    expect(() => {
      assertAuthProposalMigrationUrl(normalized, resource);
    }).not.toThrow();
    expect(original).toContain("sslmode=require");
  });

  it("leaves an already strict binding byte-for-byte unchanged", () => {
    const strict = original.replace("sslmode=require", "sslmode=verify-full");
    expect(normalizeProductionAuthMigrationUrl(strict, resource)).toBe(strict);
  });

  it.each([
    original.replace("sslmode=require", "sslmode=require&sslmode=disable"),
    original.replace("sslmode=require", "sslmode=verify-full&sslmode=require"),
    original.replace("&sslmode=require", ""),
    original.replace("sslmode=require", "sslmode=disable"),
    original.replace("sslmode=require", "sslmode=verify-ca"),
    original.replace("ep-auth.neon.tech", "ep-auth-pooler.neon.tech"),
    original.replace("ep-auth.neon.tech", "ep-other.neon.tech"),
    original.replace("/platform_auth?", "/other?"),
    original.replace("platform_auth_owner:", "platform_auth_operator:"),
    `${original}&options=-crole%3Dpostgres`,
    `${original}&channel_binding=require`,
  ])("rejects invalid or conflicting TLS, identity and query options", (value) => {
    expect(() => normalizeProductionAuthMigrationUrl(value, resource)).toThrow("resource_mismatch");
  });
});
