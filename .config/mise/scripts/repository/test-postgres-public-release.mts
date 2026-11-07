/* oxlint-disable eslint/no-await-in-loop -- This test owns one disposable cluster and verifies ordered durable journal transitions. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { z } from "zod";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle uses the existing complete database schema.
import * as schema from "../../../../lib/db/schema";
import { createPostgresPublicReleaseStore } from "../../../../lib/provisioning/public-release-store";
import { plan, authority } from "../../../../lib/provisioning/public-release-test-fixture";

const postgresFlag = process.argv.indexOf("--postgres-bin");
const postgresBin = postgresFlag === -1 ? undefined : process.argv[postgresFlag + 1];
if (postgresBin === undefined || !path.isAbsolute(postgresBin)) {
  throw new Error("An explicit local PostgreSQL binary directory is required");
}
// oxlint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp creates an exclusively owned test directory.
const scratch = await mkdtemp(path.join(tmpdir(), "a469-public-release-pg-"));
const pgdata = path.join(scratch, "data");
const passwordFile = path.join(scratch, "password");
const password = randomBytes(24).toString("hex");
const pendingState = "pending" as const;
const observedEnvId = "env-observed";
const run = (binary: string, args: string[]) => {
  const result = spawnSync(path.join(postgresBin, binary), args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`Local PostgreSQL ${binary} failed`);
  }
};
const listener = createServer();
const listening = once(listener, "listening");
listener.listen(0, "127.0.0.1");
await listening;
const address = z.object({ port: z.number().int().positive() }).safeParse(listener.address());
if (!address.success) {
  throw new Error("Local fixture port unavailable");
}
const { port } = address.data;
const closed = once(listener, "close");
listener.close();
await closed;
let started = false;
let admin: ReturnType<typeof postgres> | undefined;
let writer: ReturnType<typeof postgres> | undefined;
try {
  await writeFile(passwordFile, password, { mode: 0o600 });
  run("initdb", [
    "-D",
    pgdata,
    "--username=fixture_admin",
    "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`,
    "--no-locale",
  ]);
  run("pg_ctl", [
    "-D",
    pgdata,
    "-l",
    path.join(scratch, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
  const dsn = new URL(`postgres://127.0.0.1:${port}/postgres?sslmode=disable`);
  dsn.username = "fixture_admin";
  dsn.password = password;
  admin = postgres(dsn.toString(), {
    max: 2,
    onnotice: () => {
      /* Keep SQL/private connection notices out of retained fixture output. */
    },
  });
  await migrate(drizzle(admin), { migrationsFolder: path.resolve("drizzle") });
  await admin.unsafe(`CREATE ROLE public_release_writer LOGIN PASSWORD '${password}'`);
  await admin.unsafe(
    "GRANT SELECT, INSERT ON public.builder_provisioning_journal TO public_release_writer",
  );
  await admin.unsafe(
    "GRANT UPDATE(record, revision, state, updated_at) ON public.builder_provisioning_journal TO public_release_writer",
  );
  dsn.username = "public_release_writer";
  writer = postgres(dsn.toString(), {
    max: 2,
    onnotice: () => {
      /* Keep SQL/private connection notices out of retained fixture output. */
    },
  });
  const store = createPostgresPublicReleaseStore(drizzle(writer, { schema }));
  const initial = await store.reserve(plan);
  assert.equal(initial.revision, 1);
  const reused = await store.reserve(plan);
  assert.equal(reused.revision, 1);
  assert.equal(
    await store.read({ ...authority, ownerUserId: "foreign" }, initial.operationRef),
    undefined,
  );
  const pending = await store.compareAndSet(initial, {
    ...initial.record,
    bindings: { APP_DATABASE_URL: { state: pendingState } },
    effects: { ...initial.record.effects, "bind-production-runtime": pendingState },
  });
  assert.ok(pending);
  assert.equal(await store.compareAndSet(initial, initial.record), undefined);
  const accepted = await store.compareAndSet(pending, {
    ...pending.record,
    bindings: { APP_DATABASE_URL: { acceptedEnvId: observedEnvId, state: pendingState } },
  });
  assert.ok(accepted);
  await assert.rejects(
    store.compareAndSet(accepted, {
      ...accepted.record,
      bindings: { APP_DATABASE_URL: { acceptedEnvId: "foreign-env", state: pendingState } },
    }),
  );
  await assert.rejects(
    store.compareAndSet(accepted, {
      ...accepted.record,
      plan: { ...accepted.record.plan, publicOrigin: "https://foreign.example" },
    }),
  );
  const verified = await store.compareAndSet(accepted, {
    ...accepted.record,
    bindings: { APP_DATABASE_URL: { acceptedEnvId: observedEnvId, state: "applied" } },
  });
  assert.ok(verified);
  await assert.rejects(
    store.compareAndSet(verified, {
      ...verified.record,
      bindings: { APP_DATABASE_URL: { acceptedEnvId: observedEnvId, state: pendingState } },
    }),
  );
  const otherRef = randomUUID();
  await admin`INSERT INTO public.builder_provisioning_journal (issuer,audience,workspace_id,owner_user_id,request_id,request_digest,revision,state,record,created_at,updated_at) VALUES (${authority.issuer},${authority.audience},${authority.workspaceId},${authority.ownerUserId},${otherRef},${"f".repeat(64)},1,'pending',${JSON.stringify({ kind: "native-target-onboarding" })}::jsonb,now(),now())`;
  assert.equal(await store.read(authority, otherRef), undefined);
  const restarted = createPostgresPublicReleaseStore(drizzle(writer, { schema }));
  const restartedOperation = await restarted.read(authority, initial.operationRef);
  assert.equal(restartedOperation?.record.bindings.APP_DATABASE_URL.acceptedEnvId, "env-observed");
  console.log(
    "Public release PostgreSQL proof passed: restricted writer, restart readback, stale CAS, immutable target/row receipt, foreign owner and record-kind isolation.",
  );
} finally {
  await writer?.end();
  await admin?.end();
  if (started) {
    run("pg_ctl", ["-D", pgdata, "-m", "immediate", "-w", "stop"]);
  }
  await rm(scratch, { force: true, recursive: true });
}
