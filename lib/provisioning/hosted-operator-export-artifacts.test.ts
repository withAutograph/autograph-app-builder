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
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
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
        index: chunks.length,
        byteLength: String(part.length),
        sha256,
        artifactRef: `_protected-operator/artifacts/tenant-export/${worker.exportId}/${worker.attemptId}/data/${sha256}`,
      });
    }
    return {
      kind: "data",
      name: `table-${String(index + 1).padStart(6, "0")}.ndjson`,
      table: { schema: "public", name: `business_${index}` },
      rowCount: bytes.byteLength === 0 ? "0" : "1",
      byteLength: String(bytes.length),
      sha256: hash(bytes),
      chunks,
    };
  });
  const manifest = tenantExportArtifactManifestSchema.parse({
    version: 1,
    kind: "tenant-export",
    exportId: worker.exportId,
    attemptId: worker.attemptId,
    snapshotId: worker.snapshotId,
    planDigest: worker.planDigest,
    scope: worker.scope,
    resource: worker.resource,
    release: worker.release,
    format: worker.format,
    files,
    rowCount: String(contents.filter((bytes) => bytes.byteLength > 0).length),
    byteLength: String(contents.reduce((sum, bytes) => sum + bytes.length, 0)),
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
  return { manifest, manifestBytes, source, readMember };
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
    rows,
    current,
    store,
    artifacts: createTenantExportArtifacts({ store, assertCurrentOwner: current }),
    revoke: () => {
      revoked = true;
    },
    failReads: () => {
      unavailable = true;
    },
    failAck: () => {
      failMarkerAck = true;
    },
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
    context,
    worker: wire.worker,
    source: data.source,
    assertCurrent: f.current,
  });
  expect(await f.artifacts.inspect({ context, worker: wire.worker })).toEqual({
    status: "complete",
    completion,
  });
  expect(
    await readTenantExportManifest({
      store: f.store,
      context,
      worker: wire.worker,
      completion,
    }),
  ).toEqual(data.manifest);
  expect(
    await collect(
      streamTenantExportBytes({
        store: f.store,
        context,
        ...completion.manifest,
      }),
    ),
  ).toEqual(data.manifestBytes);
  const parts = [];
  for (const chunk of data.manifest.files[0]?.chunks ?? []) {
    parts.push(await collect(streamTenantExportBytes({ store: f.store, context, ...chunk })));
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
      context,
      worker: wire.worker,
      source: data.source,
      assertCurrent: f.current,
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
      context,
      worker: wire.worker,
      source: data.source,
      assertCurrent: f.current,
    }),
  ).rejects.toThrow();
  data.source.readManifest = vi.fn(() => Promise.reject(new Error("must not reread")));
  const completion = await f.artifacts.publish({
    context,
    worker: wire.worker,
    source: data.source,
    assertCurrent: f.current,
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
      context,
      worker: wire.worker,
      source: data.source,
      assertCurrent: f.current,
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
      context,
      worker: wire.worker,
      source: data.source,
      assertCurrent: guard,
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
    context,
    worker: wire.worker,
    source: data.source,
    assertCurrent: f.current,
  });
  const worker = {
    ...wire.worker,
    attemptId: "90000000-0000-4000-8000-000000000009",
    snapshotId: "80000000-0000-4000-8000-000000000008",
  };
  expect(await f.artifacts.inspect({ context, worker })).toEqual({ status: "incomplete" });
  const next = dataset([Buffer.from("different\n")], worker);
  await f.artifacts.publish({ context, worker, source: next.source, assertCurrent: f.current });
  expect(await f.artifacts.inspect({ context, worker })).toMatchObject({ status: "complete" });
  await expect(
    f.artifacts.publish({
      context: { ...context, target: { ...context.target, appId: "other-app" } },
      worker,
      source: next.source,
      assertCurrent: f.current,
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
      context,
      worker: { ...worker, attemptId: "70000000-0000-4000-8000-000000000007" },
      source: corrupt.source,
      assertCurrent: f.current,
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
    version: 1,
    kind: "tenant-export-plan",
    exportId: wire.worker.exportId,
    planRef: `_protected-operator/export-plans/${wire.worker.exportId}`,
    authority,
    target: { ...context.target, projectId: "original-project", branch: "original-branch" },
    originalSetup: {
      operationRef: "40000000-0000-4000-8000-000000000004",
      planDigest: "1".repeat(64),
      approvalId: "setup-approval",
      approvedByCallId: "setup-call",
    },
    scope: wire.worker.scope,
    resource: wire.worker.resource,
    release: wire.worker.release,
    selection: wire.worker.selection,
    format: wire.worker.format,
    destination: {
      kind: "owner-private-builder-artifact",
      artifactPrefix: `_protected-operator/artifacts/tenant-export/${wire.worker.exportId}`,
    },
  });
  const planDigest = tenantExportPlanDigest(plan);
  const worker = { ...wire.worker, planDigest };
  const data = dataset([Buffer.from('{"note":"business is opaque"}\n')], worker);
  const completion = await f.artifacts.publish({
    context,
    worker,
    source: data.source,
    assertCurrent: f.current,
  });
  const record = tenantExportJournalRecordSchema.parse({
    kind: "app-export",
    version: 1,
    requestId: worker.exportId,
    authority,
    target: plan.target,
    plan,
    planDigest,
    idempotencyKey: "export-call",
    revision: 8,
    fenceGeneration: 2,
    state: "complete",
    approval: {
      action: "export",
      planRef: plan.planRef,
      planDigest,
      idempotencyKey: "export-call",
      approvalId: "export-approval",
      approvedByCallId: "export-call",
    },
    attempts: [{ attemptId: worker.attemptId, snapshotId: worker.snapshotId, state: "complete" }],
    completion,
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
    store: f.store,
    authenticate,
    readCompletion,
    assertCurrentOwner,
  });
  const request = new Request(
    `https://builder.example/api/hosted-operator/exports/${worker.exportId}`,
  );
  return { ...f, data, worker, record, reader, request, authenticate, readCompletion };
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
  f.readCompletion.mockResolvedValue({ ...f.record, state: "failed", completion: undefined });
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
    context,
    worker: wire.worker,
    source: data.source,
    assertCurrent: f.current,
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
    collect(streamTenantExportBytes({ store: f.store, context, ...chunk })),
  ).rejects.toThrow();
  f.rows.set(dataKey, Buffer.from("tampered").toString("base64"));
  await expect(
    collect(streamTenantExportBytes({ store: f.store, context, ...chunk })),
  ).rejects.toThrow();
  const manifestKey = JSON.stringify([context, completion.manifest.artifactRef, 1]);
  f.rows.delete(manifestKey);
  expect(await f.artifacts.inspect({ context, worker: wire.worker })).toEqual({
    status: "unknown",
  });
});
