import assert from "node:assert/strict";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPostgresOperatorArtifactStore } from "../lib/provisioning/hosted-operator-artifact-store";
import { createPostgresOperatorArtifactSelections } from "../lib/provisioning/hosted-operator-artifact-selection";
import { createOperatorArtifactPublication } from "../lib/provisioning/hosted-operator-artifacts";
import type { OperatorArtifactContext } from "../lib/provisioning/hosted-operator-artifact-store";
import type { AppDescription } from "../lib/repository/app-description";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The production Drizzle adapter receives the actual owned schema namespace.
import * as schema from "../lib/db/schema";

const releaseManifestName = "release-manifest.json";
const manifestSchema = z.object({
  app: z.string(),
  hashes: z.object({ schema: z.string() }),
  schema_version: z.string(),
});

const [arrustedRoot, releaseDirectory, secondReleaseDirectory] = process.argv.slice(2);
if (!arrustedRoot || !releaseDirectory) {
  throw new Error(
    "usage: verify-operator-artifact-publication <arrusted-root> <relative-compiled-release-directory>",
  );
}
const scratch = await mkdtemp(path.join(tmpdir(), "operator-artifact-pg-"));
// oxlint-disable-next-line promise/avoid-new -- Reserve an ephemeral port using the native callback socket API.
const port = await new Promise<number>((resolve, reject) => {
  const listener = createServer();
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a Unix socket string or an actual TCP AddressInfo.
    if (address === null || typeof address === "string") {
      reject(new Error("fixture port unavailable"));
      return;
    }
    listener.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve(address.port);
      }
    });
  });
});
const pgData = path.join(scratch, "pgdata");
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`Owned PostgreSQL fixture ${command} failed`);
  }
};
let started = false;
let sql: ReturnType<typeof postgres> | undefined;
try {
  run("initdb", ["-D", pgData, "--auth=trust", "--username=fixture_root"]);
  run("pg_ctl", [
    "-D",
    pgData,
    "-l",
    path.join(scratch, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
  sql = postgres(`postgresql://fixture_root@127.0.0.1:${port}/postgres`);
  await sql`create table prototype_artifact_chunk(audience text not null,chunk_digest text not null,chunk_index integer not null,content text not null,created_at timestamptz not null,issuer text not null,owner_user_id text not null,path text not null,session_id text not null,transfer_digest text not null,workspace_id text not null,primary key(issuer,audience,workspace_id,owner_user_id,session_id,path,transfer_digest,chunk_index))`;
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readFile(path.join(arrustedRoot, releaseDirectory, releaseManifestName), "utf-8"),
    ),
  );
  const context: OperatorArtifactContext = {
    authority: {
      audience: "https://fixture.example/mcp",
      issuer: "https://fixture.example/api/auth",
      ownerUserId: "fixture-owner",
      workspaceId: "fixture-workspace",
    },
    target: {
      appId: manifest.app,
      sessionId: "original-fixture-session",
    },
  };
  let authorized = true;
  const assertCurrentOwner = async () => {
    await Promise.resolve();
    if (!authorized) {
      throw new Error("revoked");
    }
  };
  const store = createPostgresOperatorArtifactStore({
    assertCurrentOwner,
    database: drizzle(sql, { schema }),
  });
  const publication = createOperatorArtifactPublication({ assertCurrentOwner, store });
  const description: AppDescription = {
    app: { id: manifest.app, routes: [], workspacePath: "fixture" },
    backend: {
      authorization: "declared-policy",
      kind: "generated-postgres",
      release: {
        artifactHash: manifest.hashes.schema,
        directory: releaseDirectory,
        id: manifest.schema_version,
      },
      roles: [],
      runtime: { databaseEnvironment: "FIXTURE_DATABASE_URL" },
      schemaReceipt: null,
    },
    validation: { browser: null, check: { task: "fixture" }, test: { shards: 1, task: "fixture" } },
    version: 1,
  };
  const published = await publication.publishGeneratedRelease({
    context,
    description,
    source: {
      readBinaryFile: async (request) =>
        await readFile(path.join(arrustedRoot, request.path.replace(/^repository\//u, ""))),
    },
  });
  const read = await publication.readGeneratedRelease(context, published);
  assert.deepEqual(
    read.files[releaseManifestName],
    await readFile(path.join(arrustedRoot, releaseDirectory, releaseManifestName)),
  );
  const same = await publication.publishGeneratedRelease({
    context,
    description,
    source: {
      readBinaryFile: async (request) =>
        await readFile(path.join(arrustedRoot, request.path.replace(/^repository\//u, ""))),
    },
  });
  assert.deepEqual(same, published);
  await assert.rejects(
    store.put(context, {
      artifactRef: published.artifactRef,
      chunkIndex: 1,
      content: "conflicting retry",
    }),
  );
  await assert.rejects(
    publication.readGeneratedRelease(
      { ...context, authority: { ...context.authority, ownerUserId: "other-owner" } },
      published,
    ),
  );
  await assert.rejects(
    publication.readGeneratedRelease(
      { ...context, target: { ...context.target, sessionId: "replacement-session" } },
      published,
    ),
  );
  const selections = createPostgresOperatorArtifactSelections({
    assertCurrentOwner,
    database: drizzle(sql, { schema }),
  });
  const appSpecDigest = "a".repeat(64);
  const selection = {
    ...published,
    appId: context.target.appId,
    appSpecDigest,
    version: 1 as const,
  };
  assert.equal(await selections.read(context, appSpecDigest), undefined);
  const firstCall = "compile-call-1";
  await selections.record(context, firstCall, selection);
  assert.deepEqual(await selections.read(context, appSpecDigest), selection);
  await selections.record(context, firstCall, selection);
  await assert.rejects(
    selections.record(context, firstCall, { ...selection, releaseId: "changed" }),
  );
  assert.equal(
    await selections.read(
      { ...context, target: { ...context.target, sessionId: "other-session" } },
      appSpecDigest,
    ),
    undefined,
  );
  assert.equal(
    await selections.read(
      { ...context, authority: { ...context.authority, ownerUserId: "other-owner" } },
      appSpecDigest,
    ),
    undefined,
  );
  assert.equal(await selections.read(context, "b".repeat(64)), undefined);
  const nextDirectory = secondReleaseDirectory ?? releaseDirectory;
  const secondManifest = manifestSchema.parse(
    JSON.parse(
      await readFile(path.join(arrustedRoot, nextDirectory, releaseManifestName), "utf-8"),
    ),
  );
  const description2: AppDescription = {
    ...description,
    backend: {
      ...description.backend,
      authorization: "declared-policy",
      kind: "generated-postgres",
      release: {
        artifactHash: secondManifest.hashes.schema,
        directory: nextDirectory,
        id: secondManifest.schema_version,
      },
      roles: [],
      runtime: { databaseEnvironment: "FIXTURE_DATABASE_URL" },
      schemaReceipt: null,
    },
  };
  const publication2 = await publication.publishGeneratedRelease({
    context,
    description: description2,
    source: {
      readBinaryFile: async (request) =>
        await readFile(path.join(arrustedRoot, request.path.replace(/^repository\//u, ""))),
    },
  });
  const selection2 = { ...selection, ...publication2 };
  await selections.record(context, "compile-call-2", selection2);
  assert.deepEqual(await selections.read(context, appSpecDigest), selection2);
  const before =
    await sql`select created_at from prototype_artifact_chunk where path like '_protected-operator/selections/%' order by created_at`;
  await selections.record(context, firstCall, selection);
  const after =
    await sql`select created_at from prototype_artifact_chunk where path like '_protected-operator/selections/%' order by created_at`;
  // Exact retry does not revive an older selection marker.
  assert.deepEqual(after, before);
  assert.deepEqual(await selections.read(context, appSpecDigest), selection2);
  authorized = false;
  await assert.rejects(selections.read(context, appSpecDigest));
  await assert.rejects(selections.record(context, "revoked-call", selection));
  await assert.rejects(publication.readGeneratedRelease(context, published));
  console.log(
    "Owned PostgreSQL artifact acceptance passed: actual compiled release bytes, exact replay, immutable conflict, wrong owner/session and revoked owner denial; finalized private selections, immutable call replay, scope separation and completion order. No hosted proof.",
  );
} finally {
  await sql?.end({ timeout: 5 });
  if (started) {
    run("pg_ctl", ["-D", pgData, "-m", "immediate", "-w", "stop"]);
  }
  await rm(scratch, { force: true, recursive: true });
}
