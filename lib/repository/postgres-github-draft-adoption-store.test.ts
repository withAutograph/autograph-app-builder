import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import type { SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { hostedGitHubDraftAdoptions } from "../db/schema";
import { createPostgresGitHubDraftAdoptionStore } from "./postgres-github-draft-adoption-store";

type Database = PostgresJsDatabase<{
  hostedGitHubDraftAdoptions: typeof hostedGitHubDraftAdoptions;
}>;
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user_one",
  workspaceId: "workspace_one",
} as const;
const otherAuthority = { ...authority, ownerUserId: "user_two" };
const evidence = {
  appId: "123",
  authorId: "900",
  builderMarker: "a".repeat(64),
  originalHeadSha: "b".repeat(40),
  pullRequestId: "150000",
  pullRequestNumber: 1500,
  repositoryId: "100",
};
const rowSchema = z.strictObject({
  adoptionDigest: z.string(),
  appId: z.string(),
  audience: z.string(),
  authorId: z.string(),
  builderMarker: z.string(),
  createdAt: z.date(),
  issuer: z.string(),
  originalHeadSha: z.string(),
  ownerUserId: z.string(),
  pullRequestId: z.string(),
  pullRequestNumber: z.number(),
  repositoryId: z.string(),
  workspaceId: z.string(),
});
type Row = z.infer<typeof rowSchema>;

const sameTenantPr = (left: Row, right: Row): boolean =>
  isDeepStrictEqual(
    [
      left.issuer,
      left.audience,
      left.workspaceId,
      left.ownerUserId,
      left.repositoryId,
      left.pullRequestId,
    ],
    [
      right.issuer,
      right.audience,
      right.workspaceId,
      right.ownerUserId,
      right.repositoryId,
      right.pullRequestId,
    ],
  );

const selectedRows = (rows: Row[], condition: SQL, dialect: PgDialect) => {
  const params = z
    .tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string()])
    .parse(dialect.sqlToQuery(condition).params);
  return rows
    .filter((row) =>
      isDeepStrictEqual(
        [
          row.issuer,
          row.audience,
          row.workspaceId,
          row.ownerUserId,
          row.repositoryId,
          row.pullRequestId,
        ],
        params,
      ),
    )
    .map(
      ({
        createdAt: _createdAt,
        issuer: _issuer,
        audience: _audience,
        workspaceId: _workspaceId,
        ownerUserId: _ownerUserId,
        ...selected
      }) => selected,
    )
    .slice(0, 1);
};

const databaseFixture = () => {
  const rows: Row[] = [];
  const dialect = new PgDialect();
  const save = (value: Row) => async () => {
    const incoming = rowSchema.parse(value);
    if (!rows.some((row) => sameTenantPr(row, incoming))) {
      rows.push(incoming);
    }
    await Promise.resolve();
  };
  const limit = (condition: SQL) => async () =>
    await Promise.resolve(selectedRows(rows, condition, dialect));
  const database = {
    insert: () => ({
      values: (value: Row) => ({
        onConflictDoNothing: save(value),
      }),
    }),
    select: () => ({
      from: () => ({
        where: (condition: SQL) => ({
          limit: limit(condition),
        }),
      }),
    }),
  };
  // SAFETY: the store uses only select/from/where/limit and insert/values/onConflictDoNothing;
  // this typed fake implements those exact chains and parses every row and SQL parameter.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  return { database: database as unknown as Database, rows };
};

describe("tenant-scoped Builder draft adoption store", () => {
  it("saves the same verified draft idempotently for one tenant", async () => {
    const { database, rows } = databaseFixture();
    const store = createPostgresGitHubDraftAdoptionStore(database, authority);
    const first = await store.save(evidence);
    expect(await store.save(evidence)).toEqual(first);
    expect(first.adoptionDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows).toHaveLength(1);
    expect(await store.read(evidence.repositoryId, evidence.pullRequestId)).toEqual(first);
  });

  it("does not reveal another tenant's adoption", async () => {
    const { database, rows } = databaseFixture();
    const first = createPostgresGitHubDraftAdoptionStore(database, authority);
    const second = createPostgresGitHubDraftAdoptionStore(database, otherAuthority);
    await first.save(evidence);
    expect(await second.read(evidence.repositoryId, evidence.pullRequestId)).toBeUndefined();
    await second.save(evidence);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.ownerUserId).toSorted()).toEqual(["user_one", "user_two"]);
  });

  it("rejects a conflicting adoption for the same tenant and PR", async () => {
    const { database, rows } = databaseFixture();
    const store = createPostgresGitHubDraftAdoptionStore(database, authority);
    const first = await store.save(evidence);
    await expect(store.save({ ...evidence, builderMarker: "c".repeat(64) })).rejects.toThrow(
      /different tenant-scoped adoption record/u,
    );
    expect(rows).toHaveLength(1);
    expect(await store.read(evidence.repositoryId, evidence.pullRequestId)).toEqual(first);
  });

  it("uses an additive migration with a tenant and PR uniqueness key", async () => {
    const sql = await readFile(
      new URL("../../drizzle/0022_hosted_github_draft_adoption.sql", import.meta.url),
      "utf-8",
    );
    expect(sql).toContain('CREATE TABLE "hosted_github_draft_adoption"');
    expect(sql).toContain('CREATE UNIQUE INDEX "hosted_github_draft_adoption_pr_uidx"');
    expect(sql).toContain(
      '"issuer", "audience", "workspace_id", "owner_user_id", "repository_id", "pull_request_id"',
    );
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });
});
