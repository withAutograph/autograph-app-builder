import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  hostedStorageExpectedColumns,
  hostedStorageExpectedConstraints,
  hostedStorageExpectedIndexes,
  loadHostedStorageContract,
  verifyHostedStorageReadBack,
} from "./hosted-storage-readiness";

async function exactReadBack() {
  const contract = await loadHostedStorageContract(process.cwd());
  return {
    columns: hostedStorageExpectedColumns.map(
      ([table, column, type, notNull]) => ({
        table,
        column,
        type,
        notNull,
      })
    ),
    constraints: hostedStorageExpectedConstraints.map(([table, name]) => ({
      table,
      name,
    })),
    indexes: hostedStorageExpectedIndexes.map(([table, name]) => ({
      table,
      name,
    })),
    migrations: contract.migrations.map(({ hash, createdAt }) => ({
      hash,
      createdAt,
    })),
    transactionReadOnly: true as const,
  };
}

describe("hosted storage read-only readiness", () => {
  it("keeps managed schema expectations in database read-back order", () => {
    for (const rows of [
      hostedStorageExpectedColumns,
      hostedStorageExpectedIndexes,
      hostedStorageExpectedConstraints,
    ]) {
      expect(rows).toEqual(
        [...rows].sort(([leftTable, leftName], [rightTable, rightName]) => {
          if (leftTable !== rightTable) {
            return leftTable < rightTable ? -1 : 1;
          }
          return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
        })
      );
    }
  });

  it("emits one sanitized receipt for the exact applied schema", async () => {
    const receipt = await verifyHostedStorageReadBack({
      observedAt: new Date("2026-08-27T02:00:00.000Z"),
      readBack: await exactReadBack(),
      repositoryRoot: process.cwd(),
    });
    expect(receipt).toMatchObject({
      authority: {
        builderProvisionJournalCompareAndSetBound: true,
        githubJournalCompareAndSetBound: true,
        githubJournalExcludedFromTenantRetention: true,
        githubUserCredentialEnvelopeBound: true,
        liveMembershipPredicateBound: true,
        oauthAuthorizationSchemaBound: true,
        sandboxExecutionLeaseBound: true,
        tenantSessionPredicatesBound: true,
      },
      containsSecrets: false,
      containsTenantIdentifiers: false,
      database: {
        dialect: "postgresql",
        maxConnections: 1,
        verificationMode: "read-only-transaction",
      },
      format: "autograph-hosted-storage-readiness-v1",
      migrations: {
        additiveOnly: true,
        count: 21,
        exactOrder: true,
        noPendingMigration: true,
      },
      rollback: {
        automaticDownMigrationAvailable: false,
        destructiveMigrationDetected: false,
        providerRestorePointRequiredBeforeApply: true,
        providerRestorePointStatus: "not-proven",
      },
      status: "schema-verified",
      version: 1,
    });
    expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/u);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("workspace_");
  });

  it("rejects migration order, schema drift, and writable verification", async () => {
    const readBack = await exactReadBack();
    await expect(
      verifyHostedStorageReadBack({
        observedAt: new Date(),
        readBack: {
          ...readBack,
          migrations: [...readBack.migrations].reverse(),
        },
        repositoryRoot: process.cwd(),
      })
    ).rejects.toThrow("migration order");
    await expect(
      verifyHostedStorageReadBack({
        observedAt: new Date(),
        readBack: { ...readBack, indexes: readBack.indexes.slice(1) },
        repositoryRoot: process.cwd(),
      })
    ).rejects.toThrow("managed schema drifted");
    await expect(
      verifyHostedStorageReadBack({
        observedAt: new Date(),
        readBack: { ...readBack, transactionReadOnly: false },
        repositoryRoot: process.cwd(),
      })
    ).rejects.toThrow();
  });

  it("rejects Better Auth and OAuth table, index, or constraint drift", async () => {
    const readBack = await exactReadBack();
    for (const drifted of [
      {
        ...readBack,
        columns: readBack.columns.filter(
          (row) => !(row.table === "oauth_client" && row.column === "client_id")
        ),
      },
      {
        ...readBack,
        indexes: readBack.indexes.filter(
          (row) => row.name !== "oauth_client_client_id_uidx"
        ),
      },
      {
        ...readBack,
        constraints: readBack.constraints.filter(
          (row) => row.name !== "oauth_access_token_client_id_fkey"
        ),
      },
    ]) {
      await expect(
        verifyHostedStorageReadBack({
          observedAt: new Date(),
          readBack: drifted,
          repositoryRoot: process.cwd(),
        })
      ).rejects.toThrow("managed schema drifted");
    }
  });

  it("keeps verification read-only, secret-blind, and restore-point honest", async () => {
    const [task, cli, contract] = await Promise.all([
      readFile(".config/mise/tasks/hosted/storage-verify", "utf-8"),
      readFile("lib/db/hosted-storage-readiness-cli.mts", "utf-8"),
      readFile("lib/db/hosted-storage-readiness.ts", "utf-8"),
    ]);
    expect(task).toContain("unset DATABASE_URL");
    expect(task).toContain("--database-url-fd 0");
    expect(cli).toContain("SET TRANSACTION READ ONLY");
    expect(cli).toContain("constraint_record.contype <> 'n'");
    expect(cli).toContain("hostedStorageExpectedColumns");
    expect(cli).toContain(
      "new Set(hostedStorageExpectedColumns.map(([table]) => table))"
    );
    expect(cli.match(/[=] ANY\(\$\{managedTables\}\)/gu)).toHaveLength(3);
    expect(cli).not.toContain("process.env.DATABASE_URL");
    expect(contract).toContain(
      'providerRestorePointStatus: "not-proven" as const'
    );
    expect(contract).toContain("githubJournalExcludedFromTenantRetention");
  });

  it("fails closed on normalized-email collisions before adding personal workspaces", async () => {
    const migration = await readFile(
      "drizzle/0011_self_service_onboarding.sql",
      "utf-8"
    );
    expect(migration).toContain('GROUP BY lower("email")');
    expect(migration).toContain(
      "case-insensitive Better Auth user email collision"
    );
    expect(migration).toContain('SET "email" = lower("email")');
    expect(migration).toContain('CREATE UNIQUE INDEX "user_email_lower_uidx"');
    expect(migration).toContain('CREATE TABLE "personal_workspace"');
    expect(migration).toContain('REFERENCES "user"("id") ON DELETE CASCADE');
    expect(migration).toContain(
      'REFERENCES "organization"("id") ON DELETE CASCADE'
    );
  });
});
