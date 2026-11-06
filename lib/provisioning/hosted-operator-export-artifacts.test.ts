/* oxlint-disable eslint/no-await-in-loop -- Controlled streams and sequential recovery assertions deliberately exercise backpressure. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import {
  createTenantExportArtifacts,
  readTenantExportManifest,
  streamTenantExportBytes,
} from "./hosted-operator-export-artifacts";
import type { TenantExportPrivateSource } from "./hosted-operator-export-artifacts";
import { createTenantExportReader } from "./hosted-operator-export-reader";
import {
  hostedTenantExportPlanSchema,
  tenantExportJournalRecordSchema,
  tenantExportPlanDigest,
  tenantExportArtifactManifestSchema,
  tenantExportWireFixtureSchema,
} from "./hosted-operator-export-contract";
import type { TenantExportWorkerInput } from "./hosted-operator-export-contract";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";

const raw: unknown = JSON.parse(
  readFileSync(new URL("fixtures/tenant-export-wire-v1.json", import.meta.url), "utf-8"),
);
const wire = tenantExportWireFixtureSchema.parse(raw);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context = {
  authority,
  target: { appId: wire.worker.scope.appId, sessionId: "saved-session" },
};
const dataset = (contents: Uint8Array[], worker: TenantExportWorkerInput = wire.worker) => {
  const files = contents.map((bytes, index) => {
    const chunks = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
      const part = bytes.subarray(offset, offset + 65_536);
      const sha256 = hash(part);
      chunks.push({
        artifactRef: `_protected-operator/artifacts/tenant-export/${worker.exportId}/${worker.attemptId}/data/${sha256}`,
        byteLength: String(part.length),
        index: chunks.length,
        sha256,
      });
    }
    return {
      byteLength: String(bytes.length),
      chunks,
      kind: "data",
      name: `table-${String(index + 1).padStart(6, "0")}.ndjson`,
      rowCount: bytes.byteLength === 0 ? "0" : "1",
      sha256: hash(bytes),
      table: { name: `business_${index}`, schema: "public" },
    };
  });
  const manifest = tenantExportArtifactManifestSchema.parse({
    attemptId: worker.attemptId,
    byteLength: String(contents.reduce((sum, bytes) => sum + bytes.length, 0)),
    exportId: worker.exportId,
    files,
    format: worker.format,
    kind: "tenant-export",
    planDigest: worker.planDigest,
    release: worker.release,
    resource: worker.resource,
    rowCount: String(contents.filter((bytes) => bytes.byteLength > 0).length),
    scope: worker.scope,
    snapshotId: worker.snapshotId,
    version: 1,
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const readMember = vi.fn(async function* readMember(name: string) {
    const index = manifest.files.findIndex((file) => file.name === name);
    const bytes = contents.at(index);
    if (bytes === undefined) {
      throw new Error("Missing controlled member");
    }
    for (let offset = 0; offset < bytes.length; offset += 1301) {
      yield bytes.subarray(offset, offset + 1301);
    }
  });
  const source: TenantExportPrivateSource = {
    readManifest: vi.fn(async () => await Promise.resolve(manifestBytes)),
    readMember,
  };
  return { manifest, manifestBytes, readMember, source };
};
const fixture = () => {
  const rows = new Map<string, string>();
  let revoked = false;
  let unavailable = false;
  let failMarkerAck = false;
  const current = vi.fn(async () => {
    await Promise.resolve();
    if (revoked) {
      throw new Error("revoked");
    }
  });
  const key = (owned: OperatorArtifactContext, ref: string, index: number) =>
    JSON.stringify([owned, ref, index]);
  const store: OperatorArtifactStore = {
    async put(owned, chunk) {
      await current();
      const id = key(owned, chunk.artifactRef, chunk.chunkIndex);
      const old = rows.get(id);
      if (old !== undefined && old !== chunk.content) {
        throw new Error("Immutable content differs");
      }
      rows.set(id, chunk.content);
      if (failMarkerAck && chunk.artifactRef.includes("/completion/")) {
        failMarkerAck = false;
        throw new Error("Acknowledgement lost after durable write");
      }
    },
    async read(owned, ref, index) {
      await current();
      if (unavailable) {
        throw new Error("Read outcome unknown");
      }
      return rows.get(key(owned, ref, index));
    },
  };
  return {
    artifacts: createTenantExportArtifacts({ assertCurrentOwner: current, store }),
    current,
    failAck: () => {
      failMarkerAck = true;
    },
    failReads: () => {
      unavailable = true;
    },
    revoke: () => {
      revoked = true;
    },
    rows,
    store,
  };
};
const collect = async (bytes: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const part of bytes) {
    parts.push(part);
  }
  return Buffer.concat(parts);
};

test("streams arbitrary binary segments and opaque business bytes; preserves exact manifest", async () => {
  const f = fixture();
  const body = Buffer.from(
    '{"note":"postgres://business.invalid; SELECT password; Bearer memo; cookie; 租户😀"}\n'.repeat(
      3000,
    ),
  );
  const data = dataset([body, new Uint8Array()]);
  const completion = await f.artifacts.publish({
    assertCurrent: f.current,
    context,
    source: data.source,
    worker: wire.worker,
  });
  expect(await f.artifacts.inspect({ context, worker: wire.worker })).toEqual({
    completion,
    status: "complete",
  });
  expect(
    await readTenantExportManifest({
      completion,
      context,
      store: f.store,
      worker: wire.worker,
    }),
  ).toEqual(data.manifest);
  expect(
    await collect(
      streamTenantExportBytes({
        context,
        store: f.store,
        ...completion.manifest,
      }),
    ),
  ).toEqual(data.manifestBytes);
  const parts = [];
  for (const chunk of data.manifest.files[0]?.chunks ?? []) {
    parts.push(await collect(streamTenantExportBytes({ context, store: f.store, ...chunk })));
  }
  expect(Buffer.concat(parts)).toEqual(body);
  expect([...f.rows.values()].every((value) => Buffer.byteLength(value) <= 87_384)).toBe(true);
  const last = [...f.rows.keys()].at(-1);
  expect(last).toContain("/completion/");
});

test("zero-row tenant and zero-byte member complete without data chunks", async () => {
  for (const contents of [[], [new Uint8Array()]]) {
    const f = fixture();
    const data = dataset(contents);
    const completion = await f.artifacts.publish({
      assertCurrent: f.current,
      context,
      source: data.source,
      worker: wire.worker,
    });
    expect(completion.byteLength).toBe("0");
    expect(completion.rowCount).toBe("0");
    expect([...f.rows.keys()].some((key) => key.includes("/data/"))).toBe(false);
    const inspected = await f.artifacts.inspect({ context, worker: wire.worker });
    expect(inspected.status).toBe("complete");
  }
});

test("same-attempt completion is reconciled before reading source, including lost final acknowledgement", async () => {
  const f = fixture();
  const data = dataset([Buffer.from("one\n")]);
  f.failAck();
  await expect(
    f.artifacts.publish({
      assertCurrent: f.current,
      context,
      source: data.source,
      worker: wire.worker,
    }),
  ).rejects.toThrow();
  data.source.readManifest = vi.fn(async () => {
    throw new Error("must not reread");
  });
  const completion = await f.artifacts.publish({
    assertCurrent: f.current,
    context,
    source: data.source,
    worker: wire.worker,
  });
  expect(completion.rowCount).toBe("1");
  expect(data.source.readManifest).not.toHaveBeenCalled();
});

test("unknown reads never become absent or launch another source read", async () => {
  const f = fixture();
  const data = dataset([]);
  f.failReads();
  expect(await f.artifacts.inspect({ context, worker: wire.worker })).toEqual({
    status: "unknown",
  });
  await expect(
    f.artifacts.publish({
      assertCurrent: f.current,
      context,
      source: data.source,
      worker: wire.worker,
    }),
  ).rejects.toThrow();
  expect(data.source.readManifest).not.toHaveBeenCalled();
});

test("claim/owner loss prevents completion; partial chunks do not become a download", async () => {
  const f = fixture();
  const data = dataset([Buffer.alloc(100_000, 65)]);
  let checks = 0;
  const guard = async () => {
    await Promise.resolve();
    checks += 1;
    if (checks > 7) {
      throw new Error("claim lost");
    }
  };
  await expect(
    f.artifacts.publish({
      assertCurrent: guard,
      context,
      source: data.source,
      worker: wire.worker,
    }),
  ).rejects.toThrow();
  expect([...f.rows.keys()].some((key) => key.includes("/completion/"))).toBe(false);
  expect(await f.artifacts.inspect({ context, worker: wire.worker })).toEqual({
    status: "incomplete",
  });
  f.revoke();
  expect(await f.artifacts.inspect({ context, worker: wire.worker })).toEqual({
    status: "unknown",
  });
});

test("new attempts are isolated and reject different scope, data or manifest bytes", async () => {
  const f = fixture();
  const data = dataset([Buffer.from("original\n")]);
  await f.artifacts.publish({
    assertCurrent: f.current,
    context,
    source: data.source,
    worker: wire.worker,
  });
  const worker = {
    ...wire.worker,
    attemptId: "90000000-0000-4000-8000-000000000009",
    snapshotId: "80000000-0000-4000-8000-000000000008",
  };
  expect(await f.artifacts.inspect({ context, worker })).toEqual({ status: "incomplete" });
  const next = dataset([Buffer.from("different\n")], worker);
  await f.artifacts.publish({ assertCurrent: f.current, context, source: next.source, worker });
  expect(await f.artifacts.inspect({ context, worker })).toMatchObject({ status: "complete" });
  await expect(
    f.artifacts.publish({
      assertCurrent: f.current,
      context: { ...context, target: { ...context.target, appId: "other-app" } },
      source: next.source,
      worker,
    }),
  ).rejects.toThrow();
  const corrupt = dataset([Buffer.from("declared\n")], {
    ...worker,
    attemptId: "70000000-0000-4000-8000-000000000007",
  });
  corrupt.source.readMember = async function* readMember() {
    yield Buffer.from("tampered\n");
  };
  await expect(
    f.artifacts.publish({
      assertCurrent: f.current,
      context,
      source: corrupt.source,
      worker: { ...worker, attemptId: "70000000-0000-4000-8000-000000000007" },
    }),
  ).rejects.toThrow();
});

const readStatus = async (response: Promise<Response>) => {
  const result = await response;
  return result.status;
};

const completedFixture = async () => {
  const f = fixture();
  const plan = hostedTenantExportPlanSchema.parse({
    authority,
    destination: {
      artifactPrefix: `_protected-operator/artifacts/tenant-export/${wire.worker.exportId}`,
      kind: "owner-private-builder-artifact",
    },
    exportId: wire.worker.exportId,
    format: wire.worker.format,
    kind: "tenant-export-plan",
    originalSetup: {
      approvalId: "setup-approval",
      approvedByCallId: "setup-call",
      operationRef: "40000000-0000-4000-8000-000000000004",
      planDigest: "1".repeat(64),
    },
    planRef: `_protected-operator/export-plans/${wire.worker.exportId}`,
    release: wire.worker.release,
    resource: wire.worker.resource,
    scope: wire.worker.scope,
    selection: wire.worker.selection,
    target: { ...context.target, branch: "original-branch", projectId: "original-project" },
    version: 1,
  });
  const planDigest = tenantExportPlanDigest(plan);
  const worker = { ...wire.worker, planDigest };
  const data = dataset([Buffer.from('{"note":"business is opaque"}\n')], worker);
  const completion = await f.artifacts.publish({
    assertCurrent: f.current,
    context,
    source: data.source,
    worker,
  });
  const record = tenantExportJournalRecordSchema.parse({
    approval: {
      action: "export",
      approvalId: "export-approval",
      approvedByCallId: "export-call",
      idempotencyKey: "export-call",
      planDigest,
      planRef: plan.planRef,
    },
    attempts: [{ attemptId: worker.attemptId, snapshotId: worker.snapshotId, state: "complete" }],
    authority,
    completion,
    fenceGeneration: 2,
    idempotencyKey: "export-call",
    kind: "app-export",
    plan,
    planDigest,
    requestId: worker.exportId,
    revision: 8,
    state: "complete",
    target: plan.target,
    version: 1,
  });
  const authenticate = vi.fn(async () => await Promise.resolve(authority));
  const readCompletion = vi.fn(async () => await Promise.resolve(record));
  const assertCurrentOwner = async (owned: OperatorArtifactContext) => {
    await f.current();
    if (JSON.stringify(owned) !== JSON.stringify(context)) {
      throw new Error("canonical session/app differs");
    }
  };
  const reader = createTenantExportReader({
    assertCurrentOwner,
    authenticate,
    readCompletion,
    store: f.store,
  });
  const request = new Request(
    `https://builder.example/api/hosted-operator/exports/${worker.exportId}`,
  );
  return { ...f, authenticate, data, readCompletion, reader, record, request, worker };
};

test("owner downloads only the completed private index, exact manifest and named data", async () => {
  const f = await completedFixture();
  const index = await f.reader(f.request, { exportId: f.worker.exportId });
  expect(index.status).toBe(200);
  const publicIndex = await index.text();
  expect(publicIndex).toContain("manifest.json");
  expect(publicIndex).not.toContain("business is opaque");
  const manifest = await f.reader(f.request, {
    exportId: f.worker.exportId,
    member: ["manifest.json"],
  });
  expect(manifest.headers.get("cache-control")).toBe("private, no-store");
  expect(manifest.headers.get("content-disposition")).toBe('attachment; filename="manifest.json"');
  expect(Buffer.from(await manifest.arrayBuffer())).toEqual(f.data.manifestBytes);
  const data = await f.reader(f.request, {
    exportId: f.worker.exportId,
    member: ["table-000001.ndjson"],
  });
  expect(await data.text()).toBe('{"note":"business is opaque"}\n');
  // Downloads have no current source/project/release input or prepare-stage guard.
  expect(f.readCompletion).toHaveBeenCalledWith({ authority, exportId: f.worker.exportId });
});

test("foreign owner, session/app, missing completion and traversal cannot download", async () => {
  const f = await completedFixture();
  for (const member of [["..", "manifest.json"], ["../manifest.json"], ["unknown.ndjson"]]) {
    expect(await readStatus(f.reader(f.request, { exportId: f.worker.exportId, member }))).toBe(
      404,
    );
  }
  f.authenticate.mockResolvedValue({ ...authority, ownerUserId: "foreign" });
  expect(await readStatus(f.reader(f.request, { exportId: f.worker.exportId }))).toBe(404);
  f.authenticate.mockResolvedValue(authority);
  f.readCompletion.mockResolvedValue({
    ...f.record,
    target: { ...f.record.target, sessionId: "foreign-session" },
  });
  expect(await readStatus(f.reader(f.request, { exportId: f.worker.exportId }))).toBe(404);
  f.readCompletion.mockResolvedValue({ ...f.record, completion: undefined, state: "failed" });
  expect(await readStatus(f.reader(f.request, { exportId: f.worker.exportId }))).toBe(404);
});

test("revoked authority and uncertain immutable marker read deny retained download", async () => {
  const f = await completedFixture();
  f.failReads();
  expect(
    await readStatus(
      f.reader(f.request, { exportId: f.worker.exportId, member: ["manifest.json"] }),
    ),
  ).toBe(404);
  const revoked = await completedFixture();
  revoked.revoke();
  expect(
    await readStatus(revoked.reader(revoked.request, { exportId: revoked.worker.exportId })),
  ).toBe(404);
});

test("missing or tampered pages fail without treating unreadable completion as absent", async () => {
  const f = fixture();
  const data = dataset([Buffer.from("retained business bytes\n")]);
  const completion = await f.artifacts.publish({
    assertCurrent: f.current,
    context,
    source: data.source,
    worker: wire.worker,
  });
  const file = data.manifest.files.at(0);
  const chunk = file?.chunks.at(0);
  if (chunk === undefined) {
    throw new Error("Controlled data chunk is missing");
  }
  const dataKey = JSON.stringify([context, chunk.artifactRef, 1]);
  const stored = f.rows.get(dataKey);
  if (stored === undefined) {
    throw new Error("Controlled stored chunk is missing");
  }
  f.rows.delete(dataKey);
  await expect(
    collect(streamTenantExportBytes({ context, store: f.store, ...chunk })),
  ).rejects.toThrow();
  f.rows.set(dataKey, Buffer.from("tampered").toString("base64"));
  await expect(
    collect(streamTenantExportBytes({ context, store: f.store, ...chunk })),
  ).rejects.toThrow();
  const manifestKey = JSON.stringify([context, completion.manifest.artifactRef, 1]);
  f.rows.delete(manifestKey);
  expect(await f.artifacts.inspect({ context, worker: wire.worker })).toEqual({
    status: "unknown",
  });
});
