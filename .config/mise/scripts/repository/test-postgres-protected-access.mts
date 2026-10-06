import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { builderProvisioningJournals } from "../../../../lib/db/schema";
import { createPostgresHostedRuntimeJournalStore } from "../../../../lib/provisioning/postgres-hosted-runtime-journal";
import type { HostedRuntimeTarget } from "../../../../lib/provisioning/hosted-runtime-journal";

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
const clientA = postgres({
  database: "postgres",
  host: argument("--host"),
  max: 1,
  port,
  username: "postgres",
});
const clientB = postgres({
  database: "postgres",
  host: argument("--host"),
  max: 1,
  port,
  username: "postgres",
});
const schema = { builderProvisioningJournals };
const databaseA = drizzle(clientA, { schema });
const databaseB = drizzle(clientB, { schema });
const storeA = createPostgresHostedRuntimeJournalStore(databaseA);
const storeB = createPostgresHostedRuntimeJournalStore(databaseB);
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: `protected-access-${randomUUID()}`,
  workspaceId: `workspace-${randomUUID()}`,
};
const now = new Date();
const target = (sessionId: string): HostedRuntimeTarget => ({
  appId: "spend-review",
  branch: "preview",
  environment: "preview",
  installationId: "icfg_fixture",
  projectId: "prj_fixture",
  scopeId: "team_fixture",
  scopeType: "team",
  sessionId,
});
const plan = (selection: ReturnType<typeof target>) => ({
  access: [{ actorId: "actor_fixture", organizationId: "org_fixture", roles: ["reviewer"] }],
  action: "prepare" as const,
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app_resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "auth",
    migratorRole: "auth_owner",
    resourceId: "auth_resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context_fixture",
  cost: {
    class: "shared-recovery-group" as const,
    description: "Approved disposable compute",
    owner: "fixture owner",
  },
  effects: [
    { description: "Prepare resources", id: "resources", kind: "resources" as const },
    { description: "Install release", id: "install", kind: "install" as const },
    { description: "Grant access", id: "access", kind: "access" as const },
    { description: "Bind runtime", id: "bindings", kind: "bindings" as const },
  ],
  installer: { reference: "fixture_installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch_fixture",
    connectionRef: "connection_fixture",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon_fixture",
    source: "synthetic-only" as const,
  },
  release: { artifactRef: "artifact_fixture", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    policy: "fixture retention",
  },
  selection: {
    appId: selection.appId,
    branch: selection.branch,
    environment: selection.environment,
    projectId: selection.projectId,
    sessionId: selection.sessionId,
  },
  version: 1 as const,
});
const reserve = async (sessionId: string) => {
  const selected = target(sessionId);
  const operationRef = randomUUID();
  const record = await storeA.reserve({
    approvedByCallId: `approval-${sessionId}`,
    authority,
    now,
    operator: {
      mode: "protected-operator-v1",
      operationRef,
      plan: plan(selected),
      planDigest: "c".repeat(64),
      receipts: [],
    },
    target: selected,
  });
  const leaseId = randomUUID();
  const claimed = await storeA.compareAndSet({
    authority,
    expectedRevision: record.revision,
    now,
    record: {
      ...record.record,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      leaseId,
    },
    target: selected,
  });
  assert.ok(claimed);
  return { leaseId, operationRef, row: claimed, target: selected };
};

try {
  await migrate(databaseA, { migrationsFolder: path.resolve("drizzle") });
  const first = await reserve("session-a");
  const reserveInput = {
    authority,
    expectedRevision: first.row.revision,
    leaseId: first.leaseId,
    now,
    operationRef: first.operationRef,
    target: first.target,
  };
  const concurrent = await Promise.all([
    storeA.reserveFenceGeneration(reserveInput),
    storeB.reserveFenceGeneration(reserveInput),
  ]);
  assert.equal(concurrent.filter(Boolean).length, 1, "CAS permits one generation write");
  const afterRestart = await storeB.read({ authority, target: first.target });
  const generation = afterRestart?.record.operator?.fenceGeneration;
  assert.ok(Number.isSafeInteger(generation) && generation > 0);
  assert.equal(afterRestart?.record.operator?.operationRef, first.operationRef);
  const repeated = await storeA.reserveFenceGeneration({
    ...reserveInput,
    expectedRevision: afterRestart?.revision ?? -1,
  });
  assert.equal(repeated, undefined, "an existing operation generation cannot be replaced");
  const finalRead = await storeA.read({ authority, target: first.target });
  assert.equal(finalRead?.record.operator?.fenceGeneration, generation);

  const second = await reserve("session-b");
  const secondGeneration = await storeA.reserveFenceGeneration({
    authority,
    expectedRevision: second.row.revision,
    leaseId: second.leaseId,
    now,
    operationRef: second.operationRef,
    target: second.target,
  });
  assert.ok(secondGeneration);
  assert.ok(secondGeneration.record.operator);
  const secondFenceGeneration = secondGeneration.record.operator.fenceGeneration;
  assert.ok(
    secondFenceGeneration !== undefined && secondFenceGeneration > generation,
    "shared targets get globally increasing operation generations across sessions",
  );
  console.log(
    "Protected access journal CAS, independent-connection generation reuse, and cross-session ordering passed.",
  );
} finally {
  await Promise.all([clientA.end(), clientB.end()]);
}
