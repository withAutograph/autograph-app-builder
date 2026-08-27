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
    transactionReadOnly: true as const,
    migrations: contract.migrations.map(({ hash, createdAt }) => ({
      hash,
      createdAt,
    })),
    columns: hostedStorageExpectedColumns.map(
      ([table, column, type, notNull]) => ({
        table,
        column,
        type,
        notNull,
      }),
    ),
    indexes: hostedStorageExpectedIndexes.map(([table, name]) => ({
      table,
      name,
    })),
    constraints: hostedStorageExpectedConstraints.map(([table, name]) => ({
      table,
      name,
    })),
  };
}

describe("hosted storage read-only readiness", () => {
  it("emits one sanitized receipt for the exact applied schema", async () => {
    const receipt = await verifyHostedStorageReadBack({
      repositoryRoot: process.cwd(),
      readBack: await exactReadBack(),
      observedAt: new Date("2026-08-27T02:00:00.000Z"),
    });
    expect(receipt).toMatchObject({
      version: 1,
      format: "autograph-hosted-storage-readiness-v1",
      status: "schema-verified",
      database: {
        dialect: "postgresql",
        verificationMode: "read-only-transaction",
        maxConnections: 1,
      },
      migrations: {
        count: 5,
        exactOrder: true,
        noPendingMigration: true,
        additiveOnly: true,
      },
      authority: {
        tenantSessionPredicatesBound: true,
        liveMembershipPredicateBound: true,
        githubJournalCompareAndSetBound: true,
        githubJournalExcludedFromTenantRetention: true,
        oauthAuthorizationSchemaBound: true,
      },
      rollback: {
        destructiveMigrationDetected: false,
        automaticDownMigrationAvailable: false,
        providerRestorePointRequiredBeforeApply: true,
        providerRestorePointStatus: "not-proven",
      },
      containsSecrets: false,
      containsTenantIdentifiers: false,
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
        repositoryRoot: process.cwd(),
        readBack: {
          ...readBack,
          migrations: [...readBack.migrations].reverse(),
        },
        observedAt: new Date(),
      }),
    ).rejects.toThrow("migration order");
    await expect(
      verifyHostedStorageReadBack({
        repositoryRoot: process.cwd(),
        readBack: { ...readBack, indexes: readBack.indexes.slice(1) },
        observedAt: new Date(),
      }),
    ).rejects.toThrow("managed schema drifted");
    await expect(
      verifyHostedStorageReadBack({
        repositoryRoot: process.cwd(),
        readBack: { ...readBack, transactionReadOnly: false },
        observedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("rejects Better Auth and OAuth table, index, or constraint drift", async () => {
    const readBack = await exactReadBack();
    for (const drifted of [
      {
        ...readBack,
        columns: readBack.columns.filter(
          (row) =>
            !(row.table === "oauth_client" && row.column === "client_id"),
        ),
      },
      {
        ...readBack,
        indexes: readBack.indexes.filter(
          (row) => row.name !== "oauth_client_client_id_uidx",
        ),
      },
      {
        ...readBack,
        constraints: readBack.constraints.filter(
          (row) => row.name !== "oauth_access_token_client_id_fkey",
        ),
      },
    ]) {
      await expect(
        verifyHostedStorageReadBack({
          repositoryRoot: process.cwd(),
          readBack: drifted,
          observedAt: new Date(),
        }),
      ).rejects.toThrow("managed schema drifted");
    }
  });

  it("keeps verification read-only, secret-blind, and restore-point honest", async () => {
    const [task, cli, contract] = await Promise.all([
      readFile(".config/mise/tasks/hosted/storage-verify", "utf8"),
      readFile("lib/db/hosted-storage-readiness-cli.mts", "utf8"),
      readFile("lib/db/hosted-storage-readiness.ts", "utf8"),
    ]);
    expect(task).toContain("unset DATABASE_URL");
    expect(task).toContain("--database-url-fd 0");
    expect(cli).toContain("SET TRANSACTION READ ONLY");
    expect(cli).toContain("'github_publication_proposal'");
    expect(cli).toContain("'github_publication_proposal'");
    expect(cli).not.toContain("process.env.DATABASE_URL");
    expect(contract).toContain(
      'providerRestorePointStatus: "not-proven" as const',
    );
    expect(contract).toContain("githubJournalExcludedFromTenantRetention");
  });
});
