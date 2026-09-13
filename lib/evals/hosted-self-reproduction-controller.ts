import { randomUUID } from "node:crypto";
import type { createGitHubEvalAuthorizer, AuthorizedEvalRun } from "../eve/github-eval-oidc";

export const hostedEvalWorkload = "self-reproduction/v1" as const;
export interface EvalArtifact {
  id: string;
  contentType: string;
}
export interface RetainedEvalArtifact extends EvalArtifact {
  storageKey: string;
}
export interface HostedEvalRecord {
  id: string;
  identity: AuthorizedEvalRun;
  revision: number;
  status:
    | "starting"
    | "interrupted"
    | "running"
    | "collecting"
    | "cleaning"
    | "completed"
    | "failed";
  operationId: string;
  workerId?: string;
  cleanupAt: number;
  collectionLeaseUntil?: number;
  resultStatus?: "completed" | "failed";
  artifacts: RetainedEvalArtifact[];
  diagnostics: string[];
  cleanup: "pending" | "stopped" | "failed" | "unknown";
}
export interface HostedEvalStore {
  /** Unique durable reservation by id; never replace an existing run. */
  reserve: (record: HostedEvalRecord) => Promise<{ created: boolean; record: HostedEvalRecord }>;
  read: (id: string) => Promise<HostedEvalRecord | undefined>;
  /** Atomically replace only the exact expected revision. */
  compareAndSet: (expected: number, record: HostedEvalRecord) => Promise<boolean>;
}
export interface HostedEvalWorker {
  /** Fixed controller-owned workload; persist operation identity before creating a worker. */
  start: (input: {
    operationId: string;
    workload: typeof hostedEvalWorkload;
    cleanupAt: number;
  }) => Promise<{ workerId: string }>;
  /** Read-only recovery. An unknown result never permits launching another worker. */
  find: (operationId: string) => Promise<{ workerId: string } | undefined>;
  inspect: (workerId: string) => Promise<{
    status: "running" | "completed" | "failed";
    artifacts: EvalArtifact[];
  }>;
  /** Only evaluator-owned report artifacts; never source, environment or arbitrary paths. */
  readArtifact: (workerId: string, artifactId: string) => Promise<Uint8Array>;
  stop: (workerId: string) => Promise<void>;
}
export interface HostedEvalArtifacts {
  /** Private, idempotent durable write by run and artifact ID. */
  put: (runId: string, artifact: EvalArtifact, content: Uint8Array) => Promise<string>;
  read: (storageKey: string) => Promise<Uint8Array>;
}
const artifactId = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const identityKey = (identity: AuthorizedEvalRun) =>
  `${identity.repositoryId}:${identity.runId}:${identity.runAttempt}`;
const publicRecord = (record: HostedEvalRecord) => ({
  artifacts: record.artifacts.map(({ id, contentType }) => ({ contentType, id })),
  cleanup: record.cleanup,
  diagnostics: record.diagnostics,
  id: record.id,
  status: record.status,
});

const workerId = (record: HostedEvalRecord) => {
  if (!record.workerId) throw new Error("Eval worker identity unavailable.");
  return record.workerId;
};

/** Ports require durable adapters. This core alone does not provision a hosted evaluator. */
export const createHostedSelfReproductionController = (input: {
  authorize: ReturnType<typeof createGitHubEvalAuthorizer>;
  store: HostedEvalStore;
  worker: HostedEvalWorker;
  artifacts: HostedEvalArtifacts;
  now: () => number;
  /** Provider cleanup deadline and crash-recovery lease, set by deployment policy. */
  workerLifetimeMs: number;
  collectionLeaseMs: number;
}) => {
  const readRecord = async (id: string) => {
    const record = await input.store.read(id);
    if (!record) throw new Error("Durable eval record unavailable.");
    return record;
  };

  const update = async (record: HostedEvalRecord, changes: Partial<HostedEvalRecord>) => {
    const next = { ...record, ...changes, revision: record.revision + 1 };
    return (await input.store.compareAndSet(record.revision, next))
      ? next
      : await readRecord(record.id);
  };
  const retainWorkerReceipt = async (original: HostedEvalRecord, knownWorkerId: string) => {
    let record = original;
    // Status may advance the reservation while Sandbox creation is still in flight.
    // Keep the known worker receipt until a CAS succeeds or another observer retained it.
    while (!record.workerId) {
      const next: HostedEvalRecord = {
        ...record,
        cleanup: "pending",
        diagnostics: record.diagnostics.filter(
          (diagnostic) =>
            diagnostic !== "worker-creation-outcome-unknown; no replacement launched" &&
            diagnostic !== "worker-recovery-unavailable",
        ),
        revision: record.revision + 1,
        status: "running",
        workerId: knownWorkerId,
      };
      // oxlint-disable-next-line eslint/no-await-in-loop -- Retry the same known receipt after concurrent durable revision changes.
      if (await input.store.compareAndSet(record.revision, next)) return next;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read the actual winning revision before retrying its receipt write.
      record = await readRecord(record.id);
    }
    return record;
  };
  const authorizedRecord = async (token: string, id: string) => {
    const identity = await input.authorize(token);
    if (identityKey(identity) !== id) throw new Error("Eval run access denied.");
    const record = await input.store.read(id);
    if (
      !record ||
      record.identity.repositoryId !== identity.repositoryId ||
      record.identity.workflowRef !== identity.workflowRef ||
      record.identity.ref !== identity.ref ||
      record.identity.runId !== identity.runId ||
      record.identity.runAttempt !== identity.runAttempt
    )
      throw new Error("Eval run access denied.");
    return record;
  };
  const clean = async (record: HostedEvalRecord) => {
    let cleanup: HostedEvalRecord["cleanup"] = "stopped";
    const diagnostics = [...record.diagnostics];
    try {
      await input.worker.stop(workerId(record));
    } catch {
      cleanup = "failed";
      diagnostics.push("worker-stop-failed; provider cleanup deadline remains active");
    }
    return update(record, {
      cleanup,
      diagnostics,
      status: cleanup === "stopped" ? (record.resultStatus ?? "failed") : "failed",
    });
  };
  const reconcile = async (original: HostedEvalRecord): Promise<HostedEvalRecord> => {
    let record = original;
    if (record.status === "completed" || record.status === "failed") return record;
    if (record.status === "cleaning") return clean(record);
    if (!record.workerId) {
      let found: { workerId: string } | undefined;
      try {
        found = await input.worker.find(record.operationId);
      } catch {
        return update(record, {
          diagnostics: ["worker-recovery-unavailable"],
          status: "interrupted",
        });
      }
      if (!found)
        return update(record, {
          cleanup: "unknown",
          diagnostics: ["worker-creation-outcome-unknown; no replacement launched"],
          status: "interrupted",
        });
      record = await update(record, {
        cleanup: "pending",
        status: "running",
        workerId: found.workerId,
      });
    }
    if (record.status === "collecting" && (record.collectionLeaseUntil ?? 0) > input.now())
      return record;
    let observed: Awaited<ReturnType<HostedEvalWorker["inspect"]>>;
    try {
      observed = await input.worker.inspect(workerId(record));
    } catch {
      const failed = await update(record, {
        diagnostics: [...record.diagnostics, "worker-inspection-unavailable"],
        ...(input.now() >= record.cleanupAt
          ? { resultStatus: "failed" as const, status: "cleaning" as const }
          : {}),
      });
      return failed.status === "cleaning" ? clean(failed) : failed;
    }
    const deadlineReached = input.now() >= record.cleanupAt;
    if (observed.status === "running" && !deadlineReached) return record;
    const lease = {
      ...record,
      collectionLeaseUntil: input.now() + input.collectionLeaseMs,
      revision: record.revision + 1,
      status: "collecting" as const,
    };
    if (!(await input.store.compareAndSet(record.revision, lease)))
      return await readRecord(record.id);
    record = lease;
    const artifacts: RetainedEvalArtifact[] = [...record.artifacts];
    const diagnostics = new Set(record.diagnostics);
    const seen = new Set<string>();
    if (deadlineReached && observed.status === "running")
      diagnostics.add("worker-cleanup-deadline-reached");
    for (const artifact of observed.artifacts) {
      if (!artifactId.test(artifact.id) || seen.has(artifact.id)) {
        diagnostics.add("worker-artifact-manifest-invalid");
        continue;
      }
      seen.add(artifact.id);
      if (artifacts.some(({ id }) => id === artifact.id)) continue;
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- retain each partial artifact before cleanup
        const content = await input.worker.readArtifact(workerId(record), artifact.id);
        // oxlint-disable-next-line eslint/no-await-in-loop -- private storage writes are idempotent
        const storageKey = await input.artifacts.put(record.id, artifact, content);
        artifacts.push({ ...artifact, storageKey });
        diagnostics.delete(`artifact-retention-failed:${artifact.id}`);
      } catch {
        diagnostics.add(`artifact-retention-failed:${artifact.id}`);
      }
    }
    const pendingRetention = [...diagnostics].some((item) =>
      item.startsWith("artifact-retention-failed:"),
    );
    if (pendingRetention && input.now() < record.cleanupAt) {
      return update(record, {
        artifacts,
        collectionLeaseUntil: input.now(),
        diagnostics: [...diagnostics],
        status: "collecting",
      });
    }
    record = await update(record, {
      artifacts,
      diagnostics: [...diagnostics],
      resultStatus:
        observed.status === "completed" && diagnostics.size === 0 ? "completed" : "failed",
      status: "cleaning",
    });
    return record.status === "cleaning" ? clean(record) : record;
  };
  return {
    async artifact(token: string, id: string, requestedId: string) {
      const record = await authorizedRecord(token, id);
      const artifact = record.artifacts.find((entry) => entry.id === requestedId);
      if (!artifact || !artifactId.test(requestedId)) throw new Error("Eval artifact unavailable.");
      return {
        content: await input.artifacts.read(artifact.storageKey),
        contentType: artifact.contentType,
      };
    },
    async start(token: string) {
      const identity = await input.authorize(token);
      const reserved = await input.store.reserve({
        artifacts: [],
        cleanup: "pending",
        cleanupAt: input.now() + input.workerLifetimeMs,
        diagnostics: [],
        id: identityKey(identity),
        identity,
        operationId: randomUUID(),
        revision: 0,
        status: "starting",
      });
      if (!reserved.created) return publicRecord(await authorizedRecord(token, reserved.record.id));
      let { record } = reserved;
      try {
        const worker = await input.worker.start({
          cleanupAt: record.cleanupAt,
          operationId: record.operationId,
          workload: hostedEvalWorkload,
        });
        record = await retainWorkerReceipt(record, worker.workerId);
      } catch {
        record = await update(record, {
          cleanup: "unknown",
          diagnostics: ["worker-creation-outcome-unknown; no replacement launched"],
          status: "interrupted",
        });
      }
      return publicRecord(record);
    },
    async status(token: string, id: string) {
      return publicRecord(await reconcile(await authorizedRecord(token, id)));
    },
  };
};
