/* oxlint-disable eslint/no-await-in-loop -- The test-owned cluster applies the actual checked table definitions in order. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Production Drizzle's schema generic is retained by this real database fixture.
import * as databaseSchema from "../db/schema";
import { createPostgresAuthSchemaRolloutStore } from "./production-auth-schema-rollout-store";
import type { AuthSchemaRolloutStore } from "./production-auth-schema-rollout";
import { owner, profile, rolloutFixture } from "./production-auth-schema-rollout.test-fixture";
import type { AuthSchemaRolloutRecord } from "./production-auth-schema-rollout-contract";

const tools = [
  "/Applications/Postgres.app/Contents/Versions/17/bin",
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
].find((directory) => {
  try {
    return /PostgreSQL\) 17\./u.test(
      execFileSync(path.join(directory, "postgres"), ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return false;
  }
});
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
let root: string | undefined;
let started = false;
let client: ReturnType<typeof postgres> | undefined;
let store: AuthSchemaRolloutStore;
let record: AuthSchemaRolloutRecord;
describe.skipIf(tools === undefined)(
  "Production Auth rollout against actual PostgreSQL journal constraints",
  () => {
    beforeAll(async () => {
      if (tools === undefined) {
        throw new Error("Test-owned PostgreSQL tools unavailable");
      }
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp creates the sole private test-owned root and socket, never an existing database.
      root = await mkdtemp("/private/tmp/builder-auth-rollout-pg-");
      const data = path.join(root, "data");
      execFileSync(
        path.join(tools, "initdb"),
        ["-D", data, "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "utf-8"],
        { stdio: "pipe" },
      );
      execFileSync(
        path.join(tools, "pg_ctl"),
        [
          "-D",
          data,
          "-l",
          path.join(root, "postgres.log"),
          "-o",
          `-h '' -k ${root} -p 54329`,
          "-w",
          "start",
        ],
        { stdio: "pipe" },
      );
      started = true;
      client = postgres({
        host: root,
        port: 54_329,
        database: "postgres",
        username: userInfo().username,
        max: 4,
        ssl: false,
      });
      const config = getTableConfig(databaseSchema.builderProvisioningJournals);
      const dialect = new PgDialect();
      const definitions = config.columns.map(
        (column) =>
          `${quote(column.name)} ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}`,
      );
      definitions.push(
        ...config.primaryKeys.map(
          (key) =>
            `CONSTRAINT ${quote(key.getName())} PRIMARY KEY (${key.columns.map((column) => quote(column.name)).join(",")})`,
        ),
        ...config.checks.map(
          (check) =>
            `CONSTRAINT ${quote(check.name)} CHECK (${dialect.sqlToQuery(check.value).sql})`,
        ),
      );
      await client.unsafe(`CREATE TABLE ${quote(config.name)} (${definitions.join(",")})`);
      store = createPostgresAuthSchemaRolloutStore(drizzle(client, { schema: databaseSchema }));
      const f = rolloutFixture();
      const { plan } = await f.service.plan(owner, profile.id);
      const row = f.rows.get(plan.operationRef);
      if (row === undefined) {
        throw new Error("Fixture plan missing");
      }
      ({ record } = row);
    });
    afterAll(async () => {
      await client?.end({ timeout: 5 });
      if (started && root !== undefined && tools !== undefined) {
        execFileSync(
          path.join(tools, "pg_ctl"),
          ["-D", path.join(root, "data"), "-m", "immediate", "-w", "stop"],
          { stdio: "pipe" },
        );
      }
      if (root !== undefined) {
        await rm(root, { force: true, recursive: true });
      }
    });
    it("reserves an operation idempotently and prevents owner or session crossover", async () => {
      const first = await store.reserve(record);
      const again = await store.reserve(record);
      expect(again).toEqual(first);
      expect(
        await store.read(
          {
            ...record.plan.scope,
            authority: { ...record.plan.scope.authority, ownerUserId: "different-user" },
          },
          record.plan.operationRef,
        ),
      ).toBeUndefined();
      const read = await store.read(record.plan.scope, record.plan.operationRef);
      expect(read?.record.plan).toEqual(record.plan);
    });
    it("uses CAS and cannot rewrite the frozen schema resource, operator role or worker", async () => {
      const row = await store.reserve(record);
      const updated = await store.compareAndSet(row, {
        ...row.record,
        lease: { leaseId: "11111111-1111-4111-8111-111111111111", fenceGeneration: 1 },
      });
      expect(updated?.revision).toBe(row.revision + 1);
      expect(await store.compareAndSet(row, row.record)).toBeUndefined();
      if (updated === undefined) {
        throw new Error("CAS result missing");
      }
      await expect(
        store.compareAndSet(updated, {
          ...updated.record,
          plan: { ...updated.record.plan, authOperatorRole: "wrong_operator" },
        }),
      ).rejects.toThrow("auth_schema_rollout_journal_mismatch");
      await expect(
        store.compareAndSet(updated, {
          ...updated.record,
          runtime: {
            ...updated.record.runtime,
            worker: { ...updated.record.runtime.worker, sha256: "0".repeat(64) },
          },
        }),
      ).rejects.toThrow("auth_schema_rollout_journal_mismatch");
    });
  },
);
