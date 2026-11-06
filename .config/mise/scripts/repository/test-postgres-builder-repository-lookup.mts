/* oxlint-disable eslint/no-await-in-loop, promise/avoid-new, promise/prefer-await-to-callbacks, unicorn/no-await-expression-member -- Owned loopback setup uses callback I/O and ordered real-store assertions. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle requires the actual application schema namespace.
import * as schema from "../../../../lib/db/schema";
import { createPostgresBuilderProvisionJournalStore } from "../../../../lib/provisioning/postgres-journal";
import { builderProvisionRequestSchema } from "../../../../lib/provisioning/contracts";
import { builderProvisionJournalRecordSchema } from "../../../../lib/provisioning/journal";
// An owned loopback cluster only. Never consumes DATABASE_URL or provider credentials.
const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const postgresBin = process.argv.at(2);
assert.ok(
  postgresBin !== undefined && postgresBin.length > 0 && path.isAbsolute(postgresBin),
  "Supply an absolute installed PostgreSQL bin directory",
);
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = z.object({ port: z.number().int().positive() }).parse(server.address());
    server.close((error) => {
      if (error === undefined) {
        resolve(address.port);
      } else {
        reject(error);
      }
    });
  });
});
const scratch = await mkdtemp(path.join(tmpdir(), "builder-repository-lookup-pg-"));
const data = path.join(scratch, "postgres");
const password = randomBytes(24).toString("hex");
const passwordFile = path.join(scratch, "password");
const command = (name: string, args: string[]) => {
  const result = spawnSync(path.join(postgresBin, name), args, {
    encoding: "utf-8",
    env: { LANG: "C", LC_ALL: "C", NODE_ENV: "test", PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, `Owned PostgreSQL ${name} failed`);
};
const principal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
let started = false;
let client: ReturnType<typeof postgres> | undefined;
try {
  await writeFile(passwordFile, password, { mode: 0o600 });
  command("initdb", [
    "-D",
    data,
    "--username=fixture_admin",
    "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`,
    "--no-locale",
  ]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(scratch, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
  client = postgres({
    database: "postgres",
    host: "127.0.0.1",
    max: 5,
    onnotice: (notice) => {
      assert.ok(notice.message !== undefined);
    },
    password,
    port,
    username: "fixture_admin",
  });
  const openedClient = client;
  const database = drizzle(openedClient, { schema });
  await migrate(database, { migrationsFolder: path.join(repositoryRoot, "drizzle") });
  const store = createPostgresBuilderProvisionJournalStore(database);
  const lookup = store.findSettledAppRepository;
  assert.ok(lookup, "Real repository lookup must be implemented");
  const now = new Date("2026-11-03T00:00:00Z");
  const input = {
    appId: "lookup-app",
    authority: principal,
    githubInstallationId: "101",
    repositoryId: "501",
  };
  const seed = async (
    options: {
      authority?: typeof principal;
      pending?: boolean;
      tagged?: boolean;
      githubFailed?: boolean;
      vercelFailed?: boolean;
    } = {},
  ) => {
    const authority = options.authority ?? principal;
    const request = builderProvisionRequestSchema.parse({
      appName: "Lookup App",
      operation: "github",
      providers: { githubInstallationId: "101", vercelInstallationId: "icfg_lookup" },
      repository: { name: "lookup-app", private: true },
      requestId: randomUUID(),
      version: 1,
    });
    const reserved = await store.reserve({ authority, now, request });
    const record = builderProvisionJournalRecordSchema.parse({
      ...reserved.record,
      response: {
        ...reserved.record.response,
        github:
          options.githubFailed === true
            ? { code: "provider_unavailable", retryable: true, status: "failed" }
            : {
                defaultBranch: "main",
                fullName: "fixture/lookup-app",
                headSha: "a".repeat(40),
                headTree: "b".repeat(40),
                installationId: "101",
                name: "lookup-app",
                owner: "fixture",
                repositoryId: "501",
                scope: { id: "201", login: "fixture", type: "organization" },
                starter: {
                  contractDigest: "a".repeat(64),
                  eligibilityDigest: "b".repeat(64),
                  method: "git-clone-v1",
                  readinessDigest: "c".repeat(64),
                  receiptVersion: 4,
                  ref: "refs/heads/main",
                  repository: "https://github.com/fixture/starter",
                  sourceReceiptDigest: "d".repeat(64),
                  sourceSha: "c".repeat(40),
                  sourceTree: "d".repeat(40),
                },
                status: "succeeded",
                url: "https://github.com/fixture/lookup-app",
                visibility: "private",
              },
        status: options.pending === true ? "pending" : "settled",
        vercel:
          options.vercelFailed === true
            ? { code: "provider_unavailable", retryable: true, status: "failed" }
            : {
                dashboardUrl: "https://vercel.com/fixture/apps-lookup-app",
                framework: "services",
                installationId: "icfg_lookup",
                name: "apps-lookup-app",
                projectId: "prj_lookup",
                rootDirectory: ".",
                scope: { id: "team_lookup", slug: "fixture", type: "team" },
                status: "succeeded",
              },
      },
    });
    const saved = await store.compareAndSet({
      authority,
      expectedRevision: reserved.revision,
      now,
      record,
      requestId: request.requestId,
    });
    assert.ok(saved);
    if (options.tagged === true) {
      await openedClient`update builder_provisioning_journals set record = record || '{"kind":"not-normal-provisioning"}'::jsonb where request_id = ${request.requestId}`;
    }
    return saved;
  };
  assert.deepEqual(await lookup(input), []);
  const selected = await seed();
  assert.deepEqual(await lookup(input), [selected]);
  let checks = 2;
  for (const authority of [
    {
      ...principal,
      audience: "https://other-builder.example/mcp",
      issuer: "https://other-builder.example/api/auth",
    },
    { ...principal, workspaceId: "other-workspace" },
    { ...principal, ownerUserId: "other-owner" },
  ]) {
    await seed({ authority });
    assert.deepEqual(await lookup(input), [selected]);
    checks += 1;
  }
  for (const patch of [
    { appId: "other-app" },
    { repositoryId: "502" },
    { githubInstallationId: "102" },
  ]) {
    assert.deepEqual(await lookup({ ...input, ...patch }), []);
    checks += 1;
  }
  for (const options of [
    { pending: true },
    { tagged: true },
    { githubFailed: true },
    { vercelFailed: true },
  ]) {
    await seed(options);
    assert.deepEqual(await lookup(input), [selected]);
    checks += 1;
  }
  const before =
    await openedClient`select request_id, state, revision, record from builder_provisioning_journals order by request_id`;
  assert.deepEqual(await lookup(input), [selected]);
  const after =
    await openedClient`select request_id, state, revision, record from builder_provisioning_journals order by request_id`;
  assert.deepEqual(after, before);
  checks += 1;
  const second = await seed();
  const ambiguous = await lookup(input);
  assert.equal(ambiguous.length, 2);
  assert.deepEqual(
    new Set(ambiguous.map((row) => row.requestId)),
    new Set([selected.requestId, second.requestId]),
  );
  checks += 1;
  await seed();
  assert.equal((await lookup(input)).length, 2);
  checks += 1;
  console.log(
    JSON.stringify({
      checks,
      evidence: "owned loopback PostgreSQL; real findSettledAppRepository SQL",
      hostedAcceptance: "unassessed",
      result: "passed",
    }),
  );
} finally {
  await client?.end({ timeout: 5 });
  if (started) {
    command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  }
  await rm(scratch, { force: true, recursive: true });
}
