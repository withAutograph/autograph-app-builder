/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks -- Disposable loopback PostgreSQL uses the native socket callback API. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Exercise the real owned Drizzle schema and migration.
import * as schema from "../../../../lib/db/schema";
import { createPostgresOperatorArtifactSelections } from "../../../../lib/provisioning/hosted-operator-artifact-selection";
import type { OperatorArtifactContext } from "../../../../lib/provisioning/hosted-operator-artifact-store";

// Never consumes deployment credentials or a caller-supplied database URL.
const [, , postgresBin] = process.argv;
assert.ok(postgresBin && path.isAbsolute(postgresBin));
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
const scratch = await mkdtemp(path.join(tmpdir(), "app-publication-pg-"));
const data = path.join(scratch, "postgres");
const password = randomBytes(24).toString("hex");
const passwordFile = path.join(scratch, "password");
const command = (name: string, args: string[]) => {
  const result = spawnSync(path.join(postgresBin, name), args, {
    encoding: "utf-8",
    env: { PATH: process.env.PATH, NODE_ENV: "test", LANG: "C", LC_ALL: "C" },
  });
  assert.equal(result.status, 0, `Owned PostgreSQL ${name} failed`);
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
    host: "127.0.0.1",
    port,
    database: "postgres",
    username: "fixture_admin",
    password,
    max: 5,
    onnotice: (notice) => {
      assert.ok(notice.message !== undefined);
    },
  });
  const database = drizzle(client, { schema });
  await migrate(database, {
    migrationsFolder: path.resolve(import.meta.dirname, "../../../../drizzle"),
  });
  let authorized = true;
  const assertCurrentOwner = async () => {
    await Promise.resolve();
    if (!authorized) {
      throw new Error("owner revoked");
    }
  };
  const stores = () => createPostgresOperatorArtifactSelections({ database, assertCurrentOwner });
  const store = stores();
  const { recordDestination, readDestination } = store;
  assert.ok(recordDestination && readDestination && store.readPublishedSource);
  const context: OperatorArtifactContext = {
    authority: {
      issuer: "https://builder.example/api/auth",
      audience: "https://builder.example/mcp",
      workspaceId: "workspace",
      ownerUserId: "owner",
    },
    target: { appId: "frontend-app", sessionId: "original-session" },
  };
  const previewHtml = "<!doctype html><title>Unrelated app preview</title>";
  await database.insert(schema.prototypeArtifactChunks).values({
    ...context.authority,
    sessionId: context.target.sessionId,
    path: "preview/index.html",
    chunkIndex: 0,
    content: previewHtml,
    chunkDigest: createHash("sha256").update(previewHtml).digest("hex"),
    transferDigest: "0".repeat(64),
    createdAt: new Date(),
  });
  const first = {
    version: 1 as const,
    appId: "frontend-app",
    appSpecDigest: "a".repeat(64),
    publishedSource: {
      repositoryId: "123",
      branch: "builder/frontend-app",
      gitSha: "b".repeat(40),
      gitTree: "c".repeat(40),
      reviewDigest: "d".repeat(64),
      changeSetDigest: "e".repeat(64),
    },
  };
  const second = {
    ...first,
    publishedSource: { ...first.publishedSource, gitSha: "f".repeat(40) },
  };
  await Promise.all([
    recordDestination(context, "initial-publication", first, "initial"),
    recordDestination(context, "initial-publication", first, "initial"),
  ]);
  assert.deepEqual(await readDestination(context, first.appSpecDigest), first);
  await recordDestination(context, "revision-publication", second, "current");
  await recordDestination(context, "initial-publication", first, "initial");
  assert.deepEqual(await stores().readDestination?.(context, first.appSpecDigest), second);
  assert.deepEqual(
    await store.readPublishedSource(context, first.publishedSource),
    first.publishedSource,
  );
  assert.deepEqual(
    await store.readPublishedSource(context, second.publishedSource),
    second.publishedSource,
  );
  assert.equal(
    await store.read(context, first.appSpecDigest),
    undefined,
    "No compiled SQL release is manufactured",
  );
  await assert.rejects(recordDestination(context, "initial-publication", second, "initial"));
  // Initial Git publication succeeded but its first marker write failed; a later
  // reconciliation was recorded before recovery returned that retained old receipt.
  const missingInitial = {
    ...first,
    appSpecDigest: "7".repeat(64),
    publishedSource: { ...first.publishedSource, gitSha: "7".repeat(40), gitTree: "8".repeat(40) },
  };
  const recordedReconciliation = { ...second, appSpecDigest: missingInitial.appSpecDigest };
  await recordDestination(context, "newer-before-old-marker", recordedReconciliation, "current");
  await recordDestination(context, "late-first-initial-receipt", missingInitial, "initial");
  await recordDestination(context, "late-first-initial-receipt", missingInitial, "initial");
  assert.deepEqual(
    await stores().readDestination?.(context, missingInitial.appSpecDigest),
    recordedReconciliation,
  );
  assert.deepEqual(
    await store.readPublishedSource(context, missingInitial.publishedSource),
    missingInitial.publishedSource,
  );
  const concurrentInitial = { ...first, appSpecDigest: "8".repeat(64) };
  const concurrentCurrent = { ...second, appSpecDigest: concurrentInitial.appSpecDigest };
  await Promise.all([
    recordDestination(context, "concurrent-initial", concurrentInitial, "initial"),
    recordDestination(context, "concurrent-current", concurrentCurrent, "current"),
  ]);
  assert.deepEqual(
    await stores().readDestination?.(context, concurrentInitial.appSpecDigest),
    concurrentCurrent,
  );
  const newPullRequest = {
    ...first,
    publishedSource: {
      ...first.publishedSource,
      branch: "builder/new-reviewed-pr",
      gitSha: "8".repeat(40),
    },
  };
  await recordDestination(context, "new-initial-pr", newPullRequest, "initial");
  assert.deepEqual(await readDestination(context, first.appSpecDigest), newPullRequest);
  const recoveredNewPullRequest = {
    ...first,
    publishedSource: {
      ...first.publishedSource,
      branch: "builder/recovered-new-pr",
      gitSha: "9".repeat(40),
    },
  };
  assert.equal(
    await store.readPublishedSource(context, recoveredNewPullRequest.publishedSource),
    undefined,
  );
  await recordDestination(
    context,
    "new-pr-missing-first-marker",
    recoveredNewPullRequest,
    "initial",
  );
  await recordDestination(
    context,
    "new-pr-missing-first-marker",
    recoveredNewPullRequest,
    "initial",
  );
  assert.deepEqual(
    await stores().readDestination?.(context, first.appSpecDigest),
    recoveredNewPullRequest,
  );
  await recordDestination(context, "initial-publication", first, "initial");
  assert.deepEqual(await readDestination(context, first.appSpecDigest), recoveredNewPullRequest);
  for (const foreign of [
    { ...context, authority: { ...context.authority, ownerUserId: "other-owner" } },
    { ...context, authority: { ...context.authority, workspaceId: "other-workspace" } },
    { ...context, target: { ...context.target, sessionId: "other-session" } },
    { ...context, target: { ...context.target, appId: "other-app" } },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Separate scope denials exercise actual persisted predicates.
    assert.equal(await readDestination(foreign, first.appSpecDigest), undefined);
  }
  assert.equal(await readDestination(context, "9".repeat(64)), undefined);
  await assert.rejects(
    recordDestination(context, "wrong-app", { ...first, appId: "other-app" }, "initial"),
  );
  authorized = false;
  await assert.rejects(readDestination(context, first.appSpecDigest));
  await assert.rejects(recordDestination(context, "revoked-write", first, "initial"));
  console.log(
    "PASS: real PostgreSQL static publication destination, restart, concurrent replay, late first receipt recovery, concurrent selection, new PR marker recovery, historical source and owner/workspace/session/app isolation. No hosted effects.",
  );
} finally {
  await client?.end({ timeout: 5 });
  if (started) {
    command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  }
  await rm(scratch, { recursive: true, force: true });
}
