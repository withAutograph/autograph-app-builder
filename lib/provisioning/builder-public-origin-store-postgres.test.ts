import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import { ownedAppResourceSourceSchema } from "./owned-app-resource-source-contract";
/* oxlint-disable sonarjs/publicly-writable-directories -- mkdtemp creates the sole private owner-only fixture root; no shared socket or existing cluster is used. */
/* oxlint-disable eslint/no-await-in-loop -- Qualification applies actual table CHECK definitions in order and owns one disposable local cluster. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The production database factory uses the complete Drizzle schema generic.
import * as databaseSchema from "../db/schema";

import { provisioningJournalRetentionPredicate } from "../db/postgres-hosted-admin";
import { createBuilderPublicOriginStore } from "./builder-public-origin-store";
import type { BuilderPublicOriginStore } from "./builder-public-origin-store";

const { builderProvisioningJournals } = databaseSchema;

// Standard package-manager installations are discoverable without widening the structural test runner environment.
const tools = [
  "/Applications/Postgres.app/Contents/Versions/17/bin",
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
].find((candidate) => {
  try {
    return /PostgreSQL\) 17\./u.test(
      execFileSync(path.join(candidate, "postgres"), ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return false;
  }
});
const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const scope = {
  appId: "spend",
  projectId: "project",
  teamId: "team",
  installationId: "installation",
  provisioningRequestId: "8b22a6b1-33b9-4bdd-a152-f00e5fa373d9",
  provisioningDigest: "a".repeat(64),
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const current = () => Promise.resolve();
let root: string | undefined;
let started = false;
let client: ReturnType<typeof postgres> | undefined;
let store: BuilderPublicOriginStore;

describe.skipIf(tools === undefined)(
  "origin metadata against actual PostgreSQL table constraints",
  () => {
    beforeAll(async () => {
      if (tools === undefined) {
        throw new Error("Explicit local PostgreSQL tools are required.");
      }
      const version = execFileSync(path.join(tools, "postgres"), ["--version"], {
        encoding: "utf-8",
      });
      expect(version).toMatch(/PostgreSQL\) 17\./u);
      root = await mkdtemp("/private/tmp/a469-origin-pg-");
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
      const config = getTableConfig(builderProvisioningJournals);
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
      store = createBuilderPublicOriginStore(drizzle(client, { schema: databaseSchema }));
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
        await rm(root, { recursive: true, force: true });
      }
    });
    it("stores and reads a first metadata choice under the actual UUID/state constraints", async () => {
      expect(await store.read({ authority, scope })).toBeUndefined();
      await store.select({
        authority,
        scope,
        publicOrigin: "https://first.example",
        expectedPublicOrigin: null,
        assertCurrent: current,
      });
      expect(await store.read({ authority, scope })).toBe("https://first.example");
      if (client === undefined) {
        throw new Error("Missing owned PostgreSQL fixture.");
      }
      const rows = await client<
        { request_id: string; state: string; record: unknown }[]
      >`select request_id, state, record from builder_provisioning_journal where record->'scope'->>'appId' = ${scope.appId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(rows[0]?.state).toBe("settled");
      expect(rows[0]?.record).toMatchObject({
        kind: "builder-public-origin-choice-v1",
        selectionState: "selected",
      });
    });
    it("rejects the former non-UUID key and unsupported selected storage state using actual CHECK constraints", async () => {
      if (client === undefined) {
        throw new Error("Missing owned PostgreSQL fixture.");
      }
      for (const [requestId, state] of [
        [`builder-public-origin:${"c".repeat(64)}`, "settled"],
        ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "selected"],
      ]) {
        await expect(
          client`insert into builder_provisioning_journal (issuer,audience,owner_user_id,workspace_id,created_at,record,request_digest,request_id,revision,state,updated_at) values (${authority.issuer},${authority.audience},${authority.ownerUserId},${authority.workspaceId},now(),'{}'::jsonb,${"c".repeat(64)},${requestId},1,${state},now())`,
        ).rejects.toMatchObject({ code: "23514" });
      }
    });
    it("serializes concurrent first choices and preserves the winner against stale CAS", async () => {
      const target = { ...scope, appId: "concurrent-app" };
      const choices = ["https://one.example", "https://two.example"];
      const results = await Promise.allSettled(
        choices.map((publicOrigin) =>
          store.select({
            authority,
            scope: target,
            publicOrigin,
            expectedPublicOrigin: null,
            assertCurrent: current,
          }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = await store.read({ authority, scope: target });
      expect(choices).toContain(winner);
      await expect(
        store.select({
          authority,
          scope: target,
          publicOrigin: "https://stale.example",
          expectedPublicOrigin: null,
          assertCurrent: current,
        }),
      ).rejects.toThrow("builder_public_origin_conflict");
      expect(await store.read({ authority, scope: target })).toBe(winner);
      if (winner === undefined) {
        throw new Error("Expected committed winner.");
      }
      await store.select({
        authority,
        scope: target,
        publicOrigin: "https://next.example",
        expectedPublicOrigin: winner,
        assertCurrent: current,
      });
      expect(await store.read({ authority, scope: target })).toBe("https://next.example");
    });
    it("executes the actual retention predicate without pruning current selection metadata", async () => {
      if (client === undefined) {
        throw new Error("Missing owned PostgreSQL fixture.");
      }
      const target = { ...scope, appId: "retained-choice" };
      await store.select({
        authority,
        scope: target,
        publicOrigin: "https://retained.example",
        expectedPublicOrigin: null,
        assertCurrent: current,
      });
      await client`update builder_provisioning_journal set updated_at='2000-01-01' where record->'scope'->>'appId'=${target.appId}`;
      await client`insert into builder_provisioning_journal (issuer,audience,owner_user_id,workspace_id,created_at,record,request_digest,request_id,revision,state,updated_at) select issuer,audience,owner_user_id,workspace_id,created_at,'{}'::jsonb,request_digest,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision,state,updated_at from builder_provisioning_journal where record->'scope'->>'appId'=${target.appId}`;
      const database = drizzle(client, { schema: databaseSchema });
      await database.delete(builderProvisioningJournals).where(
        provisioningJournalRetentionPredicate({
          authority,
          deleteBefore: new Date("2026-01-01T00:00:00Z"),
        }),
      );
      expect(await store.read({ authority, scope: target })).toBe("https://retained.example");
      const expired =
        await client`select request_id from builder_provisioning_journal where request_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`;
      expect(expired).toHaveLength(0);
    });
    it("retains revision custody and only its same-owner exact referenced runtime row", async () => {
      if (client === undefined) {
        throw new Error("Missing owned PostgreSQL fixture.");
      }
      const target = hostedRuntimeTargetSchema.parse({
        appId: "retained-app",
        branch: "main",
        environment: "preview",
        installationId: "installation",
        projectId: "retained-project",
        scopeId: "team",
        scopeType: "team",
        sessionId: "original-session",
      });
      const reference = ownedAppResourceSourceSchema.parse({
        kind: "owned-app-resources-v1",
        scopeDigest: "a".repeat(64),
        source: {
          target,
          operationRef: "11111111-1111-4111-8111-111111111111",
          planDigest: "b".repeat(64),
          checkpointSha256: "c".repeat(64),
        },
      });
      const records = [
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddd01",
          owner: authority.ownerUserId,
          record: { kind: "owned-app-resource-source-v1", scope: {}, reference },
        },
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddd02",
          owner: authority.ownerUserId,
          record: { kind: "app-runtime", request: target },
        },
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddd03",
          owner: authority.ownerUserId,
          record: {
            kind: "app-runtime",
            request: { ...target, sessionId: "unreferenced-session" },
          },
        },
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddd04",
          owner: "other-owner",
          record: {
            kind: "owned-app-resource-source-v1",
            scope: {},
            reference: {
              ...reference,
              source: {
                ...reference.source,
                target: { ...target, sessionId: "foreign-reference" },
              },
            },
          },
        },
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddd05",
          owner: authority.ownerUserId,
          record: { kind: "app-runtime", request: { ...target, sessionId: "foreign-reference" } },
        },
      ];
      for (const entry of records) {
        await client`insert into builder_provisioning_journal (issuer,audience,owner_user_id,workspace_id,created_at,record,request_digest,request_id,revision,state,updated_at) values (${authority.issuer},${authority.audience},${entry.owner},${authority.workspaceId},'2000-01-01',${JSON.stringify(entry.record)}::jsonb,${"a".repeat(64)},${entry.id},1,'settled','2000-01-01')`;
      }
      await drizzle(client, { schema: databaseSchema })
        .delete(builderProvisioningJournals)
        .where(
          provisioningJournalRetentionPredicate({
            authority,
            deleteBefore: new Date("2026-01-01T00:00:00Z"),
          }),
        );
      const retained = await client<
        { request_id: string }[]
      >`select request_id from builder_provisioning_journal where request_id like 'dddddddd-%' order by request_id`;
      expect(retained.map((row) => row.request_id)).toEqual([
        records[0]?.id,
        records[1]?.id,
        records[3]?.id,
      ]);
    });
    it("isolates foreign owner/tuple reads and rolls back revoked-owner selections", async () => {
      expect(
        await store.read({ authority: { ...authority, ownerUserId: "other" }, scope }),
      ).toBeUndefined();
      expect(
        await store.read({ authority, scope: { ...scope, provisioningDigest: "b".repeat(64) } }),
      ).toBeUndefined();
      const target = { ...scope, appId: "revoked-app" };
      let checks = 0;
      await expect(
        store.select({
          authority,
          scope: target,
          publicOrigin: "https://revoked.example",
          expectedPublicOrigin: null,
          assertCurrent: () => {
            checks += 1;
            return checks === 2 ? Promise.reject(new Error("revoked")) : Promise.resolve();
          },
        }),
      ).rejects.toThrow("revoked");
      expect(await store.read({ authority, scope: target })).toBeUndefined();
    });
  },
);
