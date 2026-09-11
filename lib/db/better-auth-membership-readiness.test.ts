import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { verifyBetterAuthMembershipReadBack } from "./better-auth-membership-readiness";

const row = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  userId: "user-a",
  workspaceId: "workspace-a",
};

function readBack() {
  return {
    activeLegacyRows: [row],
    inactiveLegacyCount: 1,
    migratedRows: [{ ...row, role: "owner" as const }],
    nativeOrganizationCount: 0,
    orphanedActiveSessionCount: 0 as const,
    pendingInvitationCount: 2,
    transactionReadOnly: true as const,
  };
}

describe("Better Auth membership migration readiness", () => {
  it("returns a sanitized deterministic parity receipt", () => {
    const receipt = verifyBetterAuthMembershipReadBack({
      observedAt: new Date("2026-08-29T12:00:00.000Z"),
      readBack: readBack(),
    });

    expect(receipt.status).toBe("migration-verified");
    expect(receipt.parity).toMatchObject({
      activeLegacyMemberships: 1,
      exact: true,
      migratedOrganizationMemberships: 1,
    });
    expect(receipt.retainedLegacyAuthority).toEqual({
      authPathRetirementProven: false,
      deletionPerformed: false,
      inactiveMemberships: 1,
    });
    expect(JSON.stringify(receipt)).not.toContain("workspace-a");
    expect(JSON.stringify(receipt)).not.toContain("user-a");
    expect(receipt.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects missing, extra, non-owner, and orphaned authority", () => {
    expect(() =>
      verifyBetterAuthMembershipReadBack({
        observedAt: new Date(),
        readBack: { ...readBack(), migratedRows: [] },
      })
    ).toThrow("does not exactly match");
    expect(() =>
      verifyBetterAuthMembershipReadBack({
        observedAt: new Date(),
        readBack: {
          ...readBack(),
          migratedRows: [
            ...readBack().migratedRows,
            { ...row, userId: "unexpected", role: "owner" },
          ],
        },
      })
    ).toThrow("does not exactly match");
    expect(() =>
      verifyBetterAuthMembershipReadBack({
        observedAt: new Date(),
        readBack: {
          ...readBack(),
          migratedRows: [{ ...row, role: "member" }],
        },
      })
    ).toThrow();
    expect(() =>
      verifyBetterAuthMembershipReadBack({
        observedAt: new Date(),
        readBack: { ...readBack(), orphanedActiveSessionCount: 1 },
      })
    ).toThrow();
  });

  it("keeps migration and readback task fail-closed and secret-blind", async () => {
    const [migration, task, cli] = await Promise.all([
      readFile("drizzle/0010_better_auth_organizations.sql", "utf-8"),
      readFile(
        ".config/mise/tasks/hosted/membership-migration-verify",
        "utf-8"
      ),
      readFile("lib/db/better-auth-membership-readiness-cli.mts", "utf-8"),
    ]);

    expect(migration).toContain('CREATE TABLE "organization"');
    expect(migration).toContain('CREATE TABLE "member"');
    expect(migration).toContain('CREATE TABLE "invitation"');
    expect(migration).toContain(
      'ON "organization" ("issuer", "audience", "workspace_id")'
    );
    expect(migration).toContain(
      "active hosted workspace membership has no Better Auth user"
    );
    expect(migration).toContain("'owner'");
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/iu);
    expect(task).toContain("unset DATABASE_URL");
    expect(task).toContain("--database-url-fd 0");
    expect(cli).toContain("SET TRANSACTION READ ONLY");
    expect(cli).not.toContain("process.env.DATABASE_URL");
  });
});
