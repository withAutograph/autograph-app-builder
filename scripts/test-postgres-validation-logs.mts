import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- The shared Drizzle store requires the complete database schema type.
import * as schema from "../lib/db/schema";
import { createPostgresValidationLogStore } from "../lib/repository/postgres-validation-log-store";
import { readValidationLogPage, ValidationLogWriter } from "../lib/repository/validation-log";
import type { ValidationLogKey, ValidationLogReference } from "../lib/repository/validation-log";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
};
const port = Number(argument("--port"));
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Invalid PostgreSQL port.");
}
const client = postgres({
  database: "postgres",
  host: argument("--host"),
  max: 2,
  port,
  username: "postgres",
});
const db = drizzle(client, { schema });
const sessionId = "dependency-log-session";
const auth = (owner = "owner-a", workspace = "workspace-a") => {
  const identity = {
    attributes: {
      "mcp:audience": "https://builder.example.test/mcp",
      "mcp:scopes": ["eve:start"],
      "mcp:workspace-id": workspace,
    },
    authenticator: "mcp-oauth-jwks",
    issuer: "https://builder.example.test/api/auth",
    principalId: owner,
    principalType: "user",
    subject: owner,
  };
  return { current: identity, initiator: identity };
};
const store = createPostgresValidationLogStore({ db, sessionAuth: auth(), sessionId });
const key: ValidationLogKey = {
  attemptDigest: "a".repeat(64),
  channel: "stdout",
  command: "check-build",
  logId: "123e4567-e89b-42d3-a456-426614174001",
  sessionId,
};
const content = "legacy log coût\n";
const digest = createHash("sha256").update(content).digest("hex");
const legacyReference: ValidationLogReference = {
  bytes: Buffer.byteLength(content),
  channel: "stdout",
  chunkCount: 1,
  digest,
  logId: key.logId,
};

try {
  await client.unsafe(await readFile("drizzle/0025_validation_logs.sql", "utf-8"));
  // Exercise upgrade from the deployed integer shape as well as the bigint migration source.
  await client.unsafe(
    'ALTER TABLE "validation_log_manifest" ALTER COLUMN "byte_length" TYPE integer',
  );
  await client`
    insert into validation_log_manifest
      (issuer, audience, workspace_id, owner_user_id, session_id, log_id, attempt_digest, command, channel, digest, byte_length, chunk_count, created_at)
    values ('https://builder.example.test/api/auth', 'https://builder.example.test/mcp', 'workspace-a', 'owner-a', ${sessionId}, ${key.logId}, ${key.attemptDigest}, ${key.command}, ${key.channel}, ${digest}, ${legacyReference.bytes}, 1, now())
  `;
  await store.putChunk(key, 0, content, digest);
  const [before] = await client<
    Record<string, string | number | Date | null>[]
  >`select *, byte_length::text as byte_length_text from validation_log_manifest`;
  await client.unsafe(await readFile("drizzle/0026_validation_log_completion.sql", "utf-8"));
  const [after] = await client<
    Record<string, string | number | Date | null>[]
  >`select *, byte_length::text as byte_length_text from validation_log_manifest`;
  const { completion, ...preserved } = after;
  assert.equal(completion, null);
  // PostgreSQL changes bigint wire representation, while persisted values and all identities stay exact.
  assert.deepEqual(
    { ...preserved, byte_length: Number(preserved.byte_length) },
    { ...before, byte_length: Number(before.byte_length) },
  );
  const savedLegacy = await store.getReference(key);
  assert.deepEqual(savedLegacy, legacyReference);
  assert.equal(JSON.stringify(savedLegacy), JSON.stringify(legacyReference));
  const page = await readValidationLogPage({ digest, key, store });
  assert.equal(page.content, content);
  assert.equal(page.completion, "complete");

  const writer = new ValidationLogWriter(
    store,
    { attemptDigest: "b".repeat(64), channel: "stderr", command: "dependency-install", sessionId },
    { bestEffort: true, excerptLimit: 2400 },
  );
  await writer.append("resolved package\n".repeat(10_000));
  await writer.append("API_KEY=split-");
  await writer.append("credential\n");
  const saved = await writer.finishCapture("interrupted");
  assert.ok(saved.reference);
  let cursor: string | undefined;
  const assembledHash = createHash("sha256");
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Authenticated pages follow manifest-bound cursors.
    const next = await readValidationLogPage({
      cursor,
      digest: saved.reference.digest,
      key: writer.key,
      store,
    });
    assert.equal(next.completion, "interrupted");
    assert.ok(!next.content.includes("split-credential"));
    assembledHash.update(next.content);
    cursor = next.nextCursor;
  } while (cursor !== undefined);
  assert.equal(assembledHash.digest("hex"), saved.reference.digest);
  const foreignStore = createPostgresValidationLogStore({
    db,
    sessionAuth: auth("owner-b", "workspace-b"),
    sessionId,
  });
  await assert.rejects(
    readValidationLogPage({ digest: saved.reference.digest, key: writer.key, store: foreignStore }),
    /unavailable/u,
  );
  await assert.rejects(
    readValidationLogPage({
      digest: saved.reference.digest,
      key: { ...writer.key, attemptDigest: "c".repeat(64) },
      store,
    }),
    /unavailable/u,
  );
  const otherSession = createPostgresValidationLogStore({
    db,
    sessionAuth: auth(),
    sessionId: "other-session",
  });
  await assert.rejects(otherSession.getReference(writer.key), /invalid for this session/u);
  await assert.rejects(store.publish(writer.key, saved.reference));
  assert.deepEqual(await store.getReference(writer.key), saved.reference);

  const largeKey = { ...key, logId: "123e4567-e89b-42d3-a456-426614174002" };
  await store.publish(largeKey, {
    ...legacyReference,
    bytes: 2_147_483_648,
    logId: largeKey.logId,
  });
  const largeReference = await store.getReference(largeKey);
  assert.equal(largeReference?.bytes, 2_147_483_648);
  process.stdout.write(
    `${JSON.stringify({ bigintByteCounts: true, immutableManifests: true, legacyReferences: true, pagedReadback: true, tenantIsolation: true })}\n`,
  );
} finally {
  await client.end({ timeout: 2 });
}
