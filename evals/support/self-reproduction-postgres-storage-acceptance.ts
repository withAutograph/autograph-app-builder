import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import type {
  HostedEvalArtifacts,
  HostedEvalRecord,
  HostedEvalStore,
} from "../../lib/evals/hosted-self-reproduction-controller";

interface Storage {
  store: HostedEvalStore;
  artifacts: HostedEvalArtifacts;
}

/** Opt-in acceptance against a disposable real database; caller owns migration and cleanup. */
export const exerciseHostedPostgresStorage = async (input: {
  connect: () => Promise<{ storage: Storage; disconnect: () => Promise<void> }>;
}) => {
  const prefix = randomUUID();
  const record: HostedEvalRecord = {
    artifacts: [],
    cleanup: "pending",
    cleanupAt: Date.now() + 60_000,
    diagnostics: [],
    id: `${prefix}:1:1`,
    identity: {
      ref: "refs/heads/main",
      repositoryId: prefix,
      runAttempt: "1",
      runId: "1",
      workflowRef: "synthetic/repo/.github/workflows/eval.yml@refs/heads/main",
    },
    operationId: randomUUID(),
    revision: 0,
    status: "starting",
  };
  const first = await input.connect();
  const second = await input.connect().catch(async (error) => {
    await first.disconnect();
    throw error;
  });
  let retainedKey = "";
  const expected = new TextEncoder().encode('{"status":"partial","evidence":"original"}');
  try {
    const reservations = await Promise.all([
      first.storage.store.reserve(record),
      second.storage.store.reserve({ ...record, operationId: randomUUID() }),
    ]);
    assert.equal(
      reservations.filter((result) => result.created).length,
      1,
      "Concurrent reservation must create exactly one run",
    );
    const persisted = reservations[0].record;
    assert.equal(
      reservations[1].record.operationId,
      persisted.operationId,
      "Both reservations must observe one durable identity",
    );
    const results = await Promise.all([
      first.storage.store.compareAndSet(0, { ...persisted, revision: 1, status: "running" }),
      second.storage.store.compareAndSet(0, { ...persisted, revision: 1, status: "interrupted" }),
    ]);
    assert.equal(
      results.filter(Boolean).length,
      1,
      "Only one concurrent revision update may succeed",
    );
    assert.equal(
      await first.storage.store.compareAndSet(0, { ...persisted, revision: 1, status: "failed" }),
      false,
      "A stale update must be rejected",
    );
    const other = { ...record, id: `${prefix}:2:1`, identity: { ...record.identity, runId: "2" } };
    await first.storage.store.reserve(other);
    const artifact = { contentType: "application/json", id: "report.json" };
    retainedKey = await first.storage.artifacts.put(record.id, artifact, expected);
    assert.equal(
      await second.storage.artifacts.put(
        record.id,
        artifact,
        new TextEncoder().encode("replacement"),
      ),
      retainedKey,
    );
    const otherKey = await second.storage.artifacts.put(
      other.id,
      artifact,
      new TextEncoder().encode("other run"),
    );
    assert.notEqual(otherKey, retainedKey, "Artifact identity must include run identity");
    assert.deepEqual(
      await first.storage.artifacts.read(retainedKey),
      expected,
      "Retry must never replace original artifact",
    );
  } finally {
    await Promise.all([first.disconnect(), second.disconnect()]);
  }
  const fresh = await input.connect();
  try {
    const recovered = await fresh.storage.store.read(record.id);
    assert.equal(recovered?.revision, 1, "A fresh adapter must recover persisted state");
    assert.deepEqual(
      await fresh.storage.artifacts.read(retainedKey),
      expected,
      "Retained artifact must survive worker/client lifetime",
    );
  } finally {
    await fresh.disconnect();
  }
  return {
    applicationFunctionalCredit: false,
    concurrentCompareAndSet: "passed",
    concurrentReservation: "passed",
    freshAdapterRecovery: "passed",
    immutableArtifact: "passed",
    perRunIsolation: "passed",
    staleCompareAndSet: "passed",
  };
};
