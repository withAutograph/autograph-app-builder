import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../lib/db/schema";
import { hostedEveOperationScopes } from "../../lib/eve/hosted-auth";
import type { HostedPrincipal } from "../../lib/eve/hosted-auth";
import { createHostedEveSessionService } from "../../lib/eve/hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "../../lib/eve/hosted-service";
import type { HostedEveStore } from "../../lib/eve/hosted-store";
import { createPostgresHostedEveStore } from "../../lib/eve/postgres-hosted-store";
import { sanitizeEvidence } from "./self-reproduction-evidence";

const snapshot = (status: HostedEngineSnapshot["status"]): HostedEngineSnapshot => ({
  status,
  events: [],
});

/** Direct production-service proof, intentionally not a browser parity receipt. */
export async function exerciseReferenceLifecycle(input: {
  store: HostedEveStore;
  principal: HostedPrincipal;
}) {
  const snapshots = new Map<string, HostedEngineSnapshot>();
  const counts = { starts: 0, sends: 0, cancels: 0 };
  const transport: HostedEveTransport = {
    start: () => {
      counts.starts += 1;
      const adapterSessionId = randomUUID();
      const value = snapshot("working");
      snapshots.set(adapterSessionId, value);
      return Promise.resolve({ adapterSessionId, snapshot: value });
    },
    get: ({ adapterSessionId }) => Promise.resolve(snapshots.get(adapterSessionId)!),
    send: ({ adapterSessionId }) => {
      counts.sends += 1;
      const value = snapshot("completed");
      snapshots.set(adapterSessionId, value);
      return Promise.resolve(value);
    },
    respond: () => Promise.reject(new Error("This fixture does not support approval responses.")),
    cancel: ({ adapterSessionId }) => {
      counts.cancels += 1;
      const value = snapshot("cancelled");
      snapshots.set(adapterSessionId, value);
      return Promise.resolve(value);
    },
  };
  const service = () => createHostedEveSessionService({ ...input, transport });
  const cancellation = await service().start({
    prompt: "Controlled pending reference operation",
    clientRequestId: randomUUID(),
  });
  const cancelled = await service().cancel({ sessionId: cancellation.sessionId });
  const persistedCancel = await input.store.getSession(input.principal, cancellation.sessionId);
  const reopenedCancel = await service().get({
    sessionId: cancellation.sessionId,
    cursor: 0,
    limit: 100,
  });
  const cancelledAdapter = persistedCancel!.adapterSessionId;
  snapshots.set(cancelledAdapter, snapshot("completed"));
  const lateResult = await service().get({
    sessionId: cancellation.sessionId,
    cursor: 0,
    limit: 100,
  });
  const recovery = await service().start({
    prompt: "Controlled interrupted reference operation",
    clientRequestId: randomUUID(),
  });
  const reopened = await service().get({ sessionId: recovery.sessionId, cursor: 0, limit: 100 });
  const request = {
    sessionId: recovery.sessionId,
    message: "Continue controlled operation",
    clientRequestId: randomUUID(),
  };
  const first = await service().send(request);
  const repeated = await service().send(request);
  const persistedResult = await input.store.getSession(input.principal, recovery.sessionId);
  return {
    schemaVersion: "self-reproduction-reference-lifecycle/v1",
    producer: "evaluator",
    scope: "production hosted session service and supplied store; controlled transport",
    generationEvidence: false,
    browserParityEvidence: false,
    assertions: [
      {
        id: "cancel-acknowledged",
        passed: cancelled.status === "cancelled" && counts.cancels === 1,
      },
      {
        id: "terminal-state-persists",
        passed: persistedCancel?.status === "cancelled" && reopenedCancel.status === "cancelled",
      },
      {
        id: "late-completion-does-not-revive-cancelled-session",
        passed: lateResult.status === "cancelled",
      },
      {
        id: "service-recreation-restores-session",
        passed: reopened.sessionId === recovery.sessionId && reopened.status === "working",
      },
      {
        id: "repeated-continuation-dispatches-once",
        passed: counts.sends === 1 && first.sessionId === repeated.sessionId,
      },
      { id: "continuation-result-persists", passed: persistedResult?.status === "completed" },
    ],
    counts,
    observedStatuses: {
      cancellation: cancelled.status,
      persistedCancel: persistedCancel?.status,
      reopenedCancel: reopenedCancel.status,
      lateResult: lateResult.status,
      recovered: reopened.status,
      persistedResult: persistedResult?.status,
    },
    sessionIds: [cancellation.sessionId, recovery.sessionId],
    unassessed: [
      "browser cancellation",
      "browser recovery",
      "failed-job retry",
      "preview authorization",
      "independent child generation",
    ],
  };
}

/** Uses the evaluator-owned disposable reference database; retains rows for readback. */
export async function runReferenceLifecycle(input: { databaseUrl: string; outputRoot: string }) {
  const sql = postgres(input.databaseUrl, { max: 1 });
  const runId = randomUUID();
  const principal: HostedPrincipal = {
    issuer: "https://self-reproduction.example.test",
    audience: "reference-lifecycle",
    workspaceId: runId,
    ownerUserId: runId,
    scopes: Object.values(hostedEveOperationScopes),
  };
  try {
    const result = await exerciseReferenceLifecycle({
      principal,
      store: createPostgresHostedEveStore(drizzle(sql, { schema })),
    });
    const evidence = { ...result, persistence: "PostgreSQL", principal };
    await mkdir(input.outputRoot, { recursive: true });
    await writeFile(
      join(input.outputRoot, "reference-lifecycle.json"),
      JSON.stringify(sanitizeEvidence(evidence), null, 2),
      { mode: 0o600 },
    );
    return evidence;
  } catch (error) {
    await mkdir(input.outputRoot, { recursive: true });
    await writeFile(
      join(input.outputRoot, "reference-lifecycle-error.json"),
      JSON.stringify(
        sanitizeEvidence({
          producer: "evaluator",
          scope: "reference durable-service diagnostic",
          generationEvidence: false,
          reason: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await sql.end();
  }
}
