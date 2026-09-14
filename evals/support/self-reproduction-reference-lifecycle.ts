import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
  events: [],
  status,
});

/** Direct production-service proof, intentionally not a browser parity receipt. */
export const exerciseReferenceLifecycle = async (input: {
  store: HostedEveStore;
  principal: HostedPrincipal;
}) => {
  const snapshots = new Map<string, HostedEngineSnapshot>();
  const counts = { cancels: 0, sends: 0, starts: 0 };
  const transport: HostedEveTransport = {
    cancel: ({ adapterSessionId }) => {
      counts.cancels += 1;
      const value = snapshot("cancelled");
      snapshots.set(adapterSessionId, value);
      return Promise.resolve(value);
    },
    get: ({ adapterSessionId }) => {
      const value = snapshots.get(adapterSessionId);
      if (!value) {
        throw new Error(`Missing snapshot for ${adapterSessionId}.`);
      }
      return Promise.resolve(value);
    },
    respond: () => Promise.reject(new Error("This fixture does not support approval responses.")),
    send: ({ adapterSessionId }) => {
      counts.sends += 1;
      const value = snapshot("completed");
      snapshots.set(adapterSessionId, value);
      return Promise.resolve(value);
    },
    start: () => {
      counts.starts += 1;
      const adapterSessionId = randomUUID();
      const value = snapshot("working");
      snapshots.set(adapterSessionId, value);
      return Promise.resolve({ adapterSessionId, snapshot: value });
    },
  };
  const service = () => createHostedEveSessionService({ ...input, transport });
  const cancellation = await service().start({
    clientRequestId: randomUUID(),
    prompt: "Controlled pending reference operation",
  });
  const cancelled = await service().cancel({ sessionId: cancellation.sessionId });
  const persistedCancel = await input.store.getSession(input.principal, cancellation.sessionId);
  const reopenedCancel = await service().get({
    cursor: 0,
    limit: 100,
    sessionId: cancellation.sessionId,
  });
  if (!persistedCancel) {
    throw new Error("Cancellation session was not persisted.");
  }
  const cancelledAdapter = persistedCancel.adapterSessionId;
  snapshots.set(cancelledAdapter, snapshot("completed"));
  const lateResult = await service().get({
    cursor: 0,
    limit: 100,
    sessionId: cancellation.sessionId,
  });
  const recovery = await service().start({
    clientRequestId: randomUUID(),
    prompt: "Controlled interrupted reference operation",
  });
  const reopened = await service().get({ cursor: 0, limit: 100, sessionId: recovery.sessionId });
  const request = {
    clientRequestId: randomUUID(),
    message: "Continue controlled operation",
    sessionId: recovery.sessionId,
  };
  const first = await service().send(request);
  const repeated = await service().send(request);
  const persistedResult = await input.store.getSession(input.principal, recovery.sessionId);
  return {
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
    browserParityEvidence: false,
    counts,
    generationEvidence: false,
    observedStatuses: {
      cancellation: cancelled.status,
      lateResult: lateResult.status,
      persistedCancel: persistedCancel?.status,
      persistedResult: persistedResult?.status,
      recovered: reopened.status,
      reopenedCancel: reopenedCancel.status,
    },
    producer: "evaluator",
    schemaVersion: "self-reproduction-reference-lifecycle/v1",
    scope: "production hosted session service and supplied store; controlled transport",
    sessionIds: [cancellation.sessionId, recovery.sessionId],
    unassessed: [
      "browser cancellation",
      "browser recovery",
      "failed-job retry",
      "preview authorization",
      "independent child generation",
    ],
  };
};

/** Uses the evaluator-owned disposable reference database; retains rows for readback. */
export const runReferenceLifecycle = async (input: { databaseUrl: string; outputRoot: string }) => {
  const sql = postgres(input.databaseUrl, { max: 1 });
  const runId = randomUUID();
  const principal: HostedPrincipal = {
    audience: "reference-lifecycle",
    issuer: "https://self-reproduction.example.test",
    ownerUserId: runId,
    scopes: Object.values(hostedEveOperationScopes),
    workspaceId: runId,
  };
  try {
    const result = await exerciseReferenceLifecycle({
      principal,
      store: createPostgresHostedEveStore(drizzle(sql, { schema })),
    });
    const evidence = { ...result, persistence: "PostgreSQL", principal };
    await mkdir(input.outputRoot, { recursive: true });
    await writeFile(
      path.join(input.outputRoot, "reference-lifecycle.json"),
      JSON.stringify(sanitizeEvidence(evidence), null, 2),
      { mode: 0o600 },
    );
    return evidence;
  } catch (error) {
    await mkdir(input.outputRoot, { recursive: true });
    await writeFile(
      path.join(input.outputRoot, "reference-lifecycle-error.json"),
      JSON.stringify(
        sanitizeEvidence({
          generationEvidence: false,
          producer: "evaluator",
          reason: error instanceof Error ? error.message : String(error),
          scope: "reference durable-service diagnostic",
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
};
