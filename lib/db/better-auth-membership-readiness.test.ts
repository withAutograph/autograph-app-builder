import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { verifyBetterAuthMembershipReadBack } from "./better-auth-membership-readiness";

const row = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-a",
  userId: "user-a",
};

function readBack() {
  return {
    transactionReadOnly: true as const,
    activeLegacyRows: [row],
    migratedRows: [{ ...row, role: "owner" as const }],
    inactiveLegacyCount: 1,
    pendingInvitationCount: 2,
    nativeOrganizationCount: 0,
    orphanedActiveSessionCount: 0 as const,
  };
}

describe("Better Auth membership migration readiness", () => {
  it("returns a sanitized deterministic parity receipt", () => {
    const receipt = verifyBetterAuthMembershipReadBack({
      readBack: readBack(),
      observedAt: new Date("2026-08-29T12:00:00.000Z"),
    });

    expect(receipt.status).toBe("migration-verified");
    expect(receipt.parity).toMatchObject({
      activeLegacyMemberships: 1,
      migratedOrganizationMemberships: 1,
      exact: true,
    });
    expect(receipt.retainedLegacyAuthority).toEqual({
      inactiveMemberships: 1,
      deletionPerformed: false,
      authPathRetirementProven: false,
    });
    expect(JSON.stringify(receipt)).not.toContain("workspace-a");
    expect(JSON.stringify(receipt)).not.toContain("user-a");
    expect(receipt.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects missing, extra, non-owner, and orphaned authority", () => {
    expect(() =>
      verifyBetterAuthMembershipReadBack({
        readBack: { ...readBack(), migratedRows: [] },
        observedAt: new Date(),
      }),
    ).toThrow("does not exactly match");
    expect(() =>
      verifyBetterAuthMembershipReadBack({
        readBack: {
          ...readBack(),
          migratedRows: [
            ...readBack().migratedRows,
            { ...row, userId: "unexpected", role: "owner" },
          ],
        },
        observedAt: new Date(),
      }),
    ).toThrow("does not exactly match");
    expect(() =>
      verifyBetterAuthMembershipReadBack({
        readBack: {
          ...readBack(),
          migratedRows: [{ ...row, role: "member" }],
        },
        observedAt: new Date(),
      }),
    ).toThrow();
    expect(() =>
      verifyBetterAuthMembershipReadBack({
        readBack: { ...readBack(), orphanedActiveSessionCount: 1 },
        observedAt: new Date(),
      }),
    ).toThrow();
  });

  it("keeps migration and readback task fail-closed and secret-blind", async () => {
    const [migration, task, cli] = await Promise.all([
      readFile("drizzle/0010_better_auth_organizations.sql", "utf8"),
      readFile(".config/mise/tasks/hosted/membership-migration-verify", "utf8"),
      readFile("lib/db/better-auth-membership-readiness-cli.mts", "utf8"),
    ]);

    expect(migration).toContain('CREATE TABLE "organization"');
    expect(migration).toContain('CREATE TABLE "member"');
    expect(migration).toContain('CREATE TABLE "invitation"');
    expect(migration).toContain(
      'ON "organization" ("issuer", "audience", "workspace_id")',
    );
    expect(migration).toContain(
      "active hosted workspace membership has no Better Auth user",
    );
    expect(migration).toContain("'owner'");
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/iu);
    expect(task).toContain("unset DATABASE_URL");
    expect(task).toContain("--database-url-fd 0");
    expect(cli).toContain("SET TRANSACTION READ ONLY");
    expect(cli).not.toContain("process.env.DATABASE_URL");
  });
});
