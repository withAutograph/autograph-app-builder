/* oxlint-disable eslint/require-await -- asynchronous ports model durable adapters */
import { expect, it, vi } from "vitest";
import type { AuthorizedEvalRun } from "../eve/github-eval-oidc";
import { createHostedSelfReproductionController } from "./hosted-self-reproduction-controller";
import type { HostedEvalRecord, HostedEvalWorker } from "./hosted-self-reproduction-controller";

const owner: AuthorizedEvalRun = {
  ref: "refs/heads/main",
  repositoryId: "123",
  runAttempt: "1",
  runId: "456",
  workflowRef: "org/repo/.github/workflows/eval.yml@refs/heads/main",
};
const fixture = () => {
  const records = new Map<string, HostedEvalRecord>();
  const files = new Map<string, Uint8Array>();
  let now = 1000;
  const worker = {
    find: vi.fn(async (): Promise<{ workerId: string } | undefined> => undefined),
    inspect: vi.fn(async (): Promise<Awaited<ReturnType<HostedEvalWorker["inspect"]>>> => ({
      artifacts: [{ contentType: "application/json", id: "report.json" }],
      status: "completed",
    })),
    readArtifact: vi.fn(async () => new TextEncoder().encode('{"status":"partial"}')),
    start: vi.fn(async () => ({ workerId: "private-worker-id" })),
    stop: vi.fn(async () => {}),
  };
  const controller = createHostedSelfReproductionController({
    artifacts: {
      put: async (runId, artifact, content) => {
        const key = `${runId}/${artifact.id}`;
        files.set(key, content);
        return key;
      },
      read: async (key) => {
        const content = files.get(key);
        if (!content) throw new Error("not found");
        return content;
      },
    },
    authorize: async (token) => {
      if (token === "bad") throw new Error("unauthorized");
      return token === "other" ? { ...owner, runId: "789" } : owner;
    },
    collectionLeaseMs: 1000,
    now: () => now,
    store: {
      compareAndSet: async (revision, record) => {
        if (records.get(record.id)?.revision !== revision) return false;
        records.set(record.id, record);
        return true;
      },
      read: async (id) => records.get(id),
      reserve: async (record) => {
        const prior = records.get(record.id);
        if (prior) return { created: false, record: prior };
        records.set(record.id, record);
        return { created: true, record };
      },
    },
    worker,
    workerLifetimeMs: 10_000,
  });
  return {
    advance: () => {
      now += 20_000;
    },
    controller,
    files,
    records,
    worker,
  };
};

it("durably reserves one worker across concurrent and duplicate starts", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.controller.start("owner"),
    f.controller.start("owner"),
  ]);
  expect(first.id).toBe(second.id);
  await f.controller.start("owner");
  expect(f.worker.start).toHaveBeenCalledOnce();
  expect(f.worker.start).toHaveBeenCalledWith(
    expect.objectContaining({ workload: "self-reproduction/v1" }),
  );
  expect(JSON.stringify(first)).not.toContain("private-worker-id");
});
it("rejects cross-run status and artifact requests before worker or storage access", async () => {
  const f = fixture();
  const run = await f.controller.start("owner");
  await expect(f.controller.status("other", run.id)).rejects.toThrow("access denied");
  await expect(f.controller.artifact("other", run.id, "report.json")).rejects.toThrow(
    "access denied",
  );
  await expect(f.controller.start("bad")).rejects.toThrow("unauthorized");
  expect(f.worker.inspect).not.toHaveBeenCalled();
});
it("does not duplicate uncertain creation and can reconnect by persisted operation", async () => {
  const f = fixture();
  f.worker.start.mockRejectedValueOnce(new Error("connection lost after creation"));
  const run = await f.controller.start("owner");
  expect(run.status).toBe("interrupted");
  await f.controller.start("owner");
  const observed1 = await f.controller.status("owner", run.id);
  expect(observed1.status).toBe("interrupted");
  expect(f.worker.start).toHaveBeenCalledOnce();
  f.worker.find.mockResolvedValueOnce({ workerId: "recovered" });
  await f.controller.status("owner", run.id);
  expect(f.worker.stop).toHaveBeenCalledWith("recovered");
});
it("retains partial failed-run artifacts before cleanup and serves them after cleanup", async () => {
  const f = fixture();
  f.worker.inspect.mockResolvedValue({
    artifacts: [
      { contentType: "application/json", id: "report.json" },
      { contentType: "image/png", id: "missing.png" },
    ],
    status: "failed",
  });
  f.worker.readArtifact
    .mockResolvedValueOnce(new Uint8Array([1]))
    .mockRejectedValueOnce(new Error("missing"));
  const run = await f.controller.start("owner");
  f.worker.stop.mockImplementation(async () => {
    expect(f.records.get(run.id)?.artifacts).toHaveLength(1);
    expect(f.records.get(run.id)?.status).toBe("cleaning");
  });
  const result = await f.controller.status("owner", run.id);
  expect(result.status).toBe("failed");
  expect(result.cleanup).toBe("stopped");
  expect(result.diagnostics).toContain("artifact-retention-failed:missing.png");
  const observed2 = await f.controller.artifact("owner", run.id, "report.json");
  expect(observed2.content).toEqual(new Uint8Array([1]));
  await expect(f.controller.artifact("owner", run.id, "../secret")).rejects.toThrow("unavailable");
});
it("collects once across concurrent polls and records timeout cleanup failure", async () => {
  const f = fixture();
  const run = await f.controller.start("owner");
  f.advance();
  f.worker.inspect.mockResolvedValue({ artifacts: [], status: "running" });
  f.worker.stop.mockRejectedValue(new Error("provider unavailable"));
  await Promise.all([f.controller.status("owner", run.id), f.controller.status("owner", run.id)]);
  const record = f.records.get(run.id) as HostedEvalRecord;
  expect(record.status).toBe("failed");
  expect(record.cleanup).toBe("failed");
  expect(record.diagnostics).toContain("worker-cleanup-deadline-reached");
  expect(f.worker.stop).toHaveBeenCalledOnce();
});
it("recovers cleanup after a persisted artifact manifest without rereading stopped worker files", async () => {
  const f = fixture();
  const run = await f.controller.start("owner");
  const record = f.records.get(run.id) as HostedEvalRecord;
  f.records.set(run.id, {
    ...record,
    artifacts: [{ contentType: "application/json", id: "report.json", storageKey: "retained" }],
    resultStatus: "completed",
    status: "cleaning",
  });
  f.files.set("retained", new Uint8Array([2]));
  const observed3 = await f.controller.status("owner", run.id);
  expect(observed3.status).toBe("completed");
  expect(f.worker.inspect).not.toHaveBeenCalled();
  const observed4 = await f.controller.artifact("owner", run.id, "report.json");
  expect(observed4.content).toEqual(new Uint8Array([2]));
});

it("accepts JSONB identity key ordering without weakening claim equality", async () => {
  const f = fixture();
  const run = await f.controller.start("owner");
  const record = f.records.get(run.id) as HostedEvalRecord;
  f.records.set(run.id, {
    ...record,
    identity: Object.fromEntries(
      Object.entries(owner).toReversed(),
    ) as unknown as AuthorizedEvalRun,
  });
  const observed5 = await f.controller.status("owner", run.id);
  expect(observed5.status).toBe("completed");
  f.records.set(run.id, { ...record, identity: { ...owner, workflowRef: "different" } });
  await expect(f.controller.status("owner", run.id)).rejects.toThrow("access denied");
  await expect(f.controller.start("owner")).rejects.toThrow("access denied");
});
it("stops a known worker at its cleanup deadline even if inspection fails", async () => {
  const f = fixture();
  const run = await f.controller.start("owner");
  f.advance();
  f.worker.inspect.mockRejectedValue(new Error("inspection unavailable"));
  const result = await f.controller.status("owner", run.id);
  expect(result.status).toBe("failed");
  expect(result.cleanup).toBe("stopped");
  expect(result.diagnostics).toContain("worker-inspection-unavailable");
  expect(f.worker.stop).toHaveBeenCalledOnce();
});
