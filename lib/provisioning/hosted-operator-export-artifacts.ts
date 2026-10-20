/* oxlint-disable unicorn/prefer-bigint-literals -- The configured ES2018 TypeScript target requires BigInt constructors. */
/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Private streams use sequential backpressure and fresh authority checks; parallel reads would buffer the full workload. */
import { createHash } from "node:crypto";
import {
  parseTenantExportManifestForWorker,
  tenantExportJournalRecordSchema,
  tenantExportArtifactManifestSchema,
  tenantExportWorkerInputSchema,
} from "./hosted-operator-export-contract";
import type {
  TenantExportArtifactManifest,
  TenantExportDataMember,
  TenantExportJournalRecord,
  TenantExportWorkerInput,
} from "./hosted-operator-export-contract";
import { operatorArtifactUnavailable } from "./hosted-operator-artifact-store";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";

export type TenantExportCompletion = NonNullable<TenantExportJournalRecord["completion"]>;
export interface TenantExportPrivateSource {
  readManifest: () => Promise<Uint8Array>;
  readMember: (name: string) => AsyncIterable<Uint8Array>;
}
export type TenantExportArtifactInspection =
  | { status: "complete"; completion: TenantExportCompletion }
  | { status: "incomplete" }
  | { status: "unknown" };
type ReadStore = Pick<OperatorArtifactStore, "read">;
type AssertCurrent = () => Promise<void>;
const pageBytes = 65_536;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const completionSchema = tenantExportJournalRecordSchema.shape.completion.unwrap();
const parsedJson = (bytes: Uint8Array) => {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return value;
};
const markerRef = (worker: TenantExportWorkerInput) =>
  `_protected-operator/artifacts/tenant-export/${worker.exportId}/${worker.attemptId}/completion/${hash(JSON.stringify(tenantExportWorkerInputSchema.parse(worker)))}`;
const assertScope = (context: OperatorArtifactContext, worker: TenantExportWorkerInput) => {
  if (context.target.appId !== worker.scope.appId) {
    throw operatorArtifactUnavailable();
  }
};

const writeVerified = async (input: {
  store: OperatorArtifactStore;
  context: OperatorArtifactContext;
  artifactRef: string;
  chunkIndex: number;
  content: string;
  assertCurrent: AssertCurrent;
}) => {
  await input.assertCurrent();
  await input.store.put(input.context, input);
  await input.assertCurrent();
  // The guarded immutable store performs acknowledgement readback itself.
};

/** Pages bound a single DB message, never the total export. Business bytes are opaque. */
const publishBytes = async (input: {
  store: OperatorArtifactStore;
  context: OperatorArtifactContext;
  artifactRef: string;
  bytes: AsyncIterable<Uint8Array>;
  byteLength: string;
  sha256: string;
  assertCurrent: AssertCurrent;
}) => {
  const digest = createHash("sha256");
  let count = BigInt(0);
  let page = Buffer.alloc(pageBytes);
  let used = 0;
  let pageCount = 0;
  const writePage = async () => {
    pageCount += 1;
    if (!Number.isSafeInteger(pageCount)) {
      throw operatorArtifactUnavailable();
    }
    await writeVerified({
      ...input,
      chunkIndex: pageCount,
      content: page.subarray(0, used).toString("base64"),
    });
    page = Buffer.alloc(pageBytes);
    used = 0;
  };
  for await (const segment of input.bytes) {
    digest.update(segment);
    count += BigInt(segment.byteLength);
    if (count > BigInt(input.byteLength)) {
      throw operatorArtifactUnavailable();
    }
    let offset = 0;
    while (offset < segment.byteLength) {
      const length = Math.min(pageBytes - used, segment.byteLength - offset);
      page.set(segment.subarray(offset, offset + length), used);
      offset += length;
      used += length;
      if (used === pageBytes) {
        await writePage();
      }
    }
  }
  if (used > 0) {
    await writePage();
  }
  if (count.toString() !== input.byteLength || digest.digest("hex") !== input.sha256) {
    throw operatorArtifactUnavailable();
  }
};

/** Reads only immutable private pages. Failures propagate; undefined alone means absent.
 * @yields {Uint8Array} Bounded, verified private byte pages.
 */
export const streamTenantExportBytes = async function* streamTenantExportBytes(input: {
  store: ReadStore;
  context: OperatorArtifactContext;
  artifactRef: string;
  byteLength: string;
  sha256: string;
}): AsyncGenerator<Uint8Array> {
  // The final attempt marker is the completion boundary; the approved
  // manifest already supplies this artifact's exact size and content digest.
  const expectedBytes = BigInt(input.byteLength);
  const pageCount = (expectedBytes + BigInt(pageBytes) - BigInt(1)) / BigInt(pageBytes);
  const digest = createHash("sha256");
  let count = BigInt(0);
  for (let index = BigInt(1); index <= pageCount; index += BigInt(1)) {
    const chunkIndex = Number(index);
    if (!Number.isSafeInteger(chunkIndex)) {
      throw operatorArtifactUnavailable();
    }
    const content = await input.store.read(input.context, input.artifactRef, chunkIndex);
    if (content === undefined || content.length > Math.ceil(pageBytes / 3) * 4) {
      throw operatorArtifactUnavailable();
    }
    const bytes = Buffer.from(content, "base64");
    const invalidPageLength = bytes.length === 0 || bytes.length > pageBytes;
    if (
      invalidPageLength ||
      bytes.toString("base64") !== content ||
      (index < pageCount && bytes.length !== pageBytes)
    ) {
      throw operatorArtifactUnavailable();
    }
    count += BigInt(bytes.byteLength);
    if (count > BigInt(input.byteLength)) {
      throw operatorArtifactUnavailable();
    }
    digest.update(bytes);
    yield bytes;
  }
  if (count.toString() !== input.byteLength || digest.digest("hex") !== input.sha256) {
    throw operatorArtifactUnavailable();
  }
};

const singleBytes = async function* singleBytes(bytes: Uint8Array) {
  yield bytes;
};

const readManifestEnvelope = async (input: {
  store: ReadStore;
  context: OperatorArtifactContext;
  worker: TenantExportWorkerInput;
  completion: TenantExportCompletion;
}): Promise<{ manifest: TenantExportArtifactManifest; bytes: Uint8Array }> => {
  assertScope(input.context, input.worker);
  const completion = completionSchema.parse(input.completion);
  if (
    completion.attemptId !== input.worker.attemptId ||
    completion.snapshotId !== input.worker.snapshotId ||
    !completion.manifest.artifactRef.startsWith(
      `_protected-operator/artifacts/tenant-export/${input.worker.exportId}/${input.worker.attemptId}/manifest/`,
    )
  ) {
    throw operatorArtifactUnavailable();
  }
  const parts: Uint8Array[] = [];
  for await (const bytes of streamTenantExportBytes({
    ...input,
    ...completion.manifest,
  })) {
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  const manifest = parseTenantExportManifestForWorker(
    input.worker,
    tenantExportArtifactManifestSchema.parse(parsedJson(bytes)),
  );
  if (
    completion.fileCount !== String(manifest.files.length) ||
    completion.rowCount !== manifest.rowCount ||
    completion.byteLength !== manifest.byteLength
  ) {
    throw operatorArtifactUnavailable();
  }
  return { manifest, bytes };
};

export const readTenantExportManifest = async (
  input: Parameters<typeof readManifestEnvelope>[0],
) => {
  const envelope = await readManifestEnvelope(input);
  return envelope.manifest;
};

const publishMember = async (input: {
  store: OperatorArtifactStore;
  context: OperatorArtifactContext;
  file: TenantExportDataMember;
  source: TenantExportPrivateSource;
  assertCurrent: AssertCurrent;
}) => {
  const iterator = input.source.readMember(input.file.name)[Symbol.asyncIterator]();
  let pending: Uint8Array = new Uint8Array(0);
  let offset = 0;
  const digest = createHash("sha256");
  const take = async function* take(length: bigint) {
    let remaining = length;
    while (remaining > BigInt(0)) {
      if (offset === pending.byteLength) {
        const next = await iterator.next();
        if (next.done === true) {
          throw operatorArtifactUnavailable();
        }
        pending = next.value;
        offset = 0;
        continue;
      }
      const size = Number(
        remaining < BigInt(pending.byteLength - offset)
          ? remaining
          : BigInt(pending.byteLength - offset),
      );
      const bytes = pending.subarray(offset, offset + size);
      digest.update(bytes);
      offset += size;
      remaining -= BigInt(size);
      yield bytes;
    }
  };
  try {
    for (const chunk of input.file.chunks) {
      await publishBytes({ ...input, ...chunk, bytes: take(BigInt(chunk.byteLength)) });
    }
    if (offset !== pending.byteLength) {
      throw operatorArtifactUnavailable();
    }
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      if (next.value.byteLength !== 0) {
        throw operatorArtifactUnavailable();
      }
    }
    if (digest.digest("hex") !== input.file.sha256) {
      throw operatorArtifactUnavailable();
    }
  } finally {
    await iterator.return?.();
  }
};

export const inspectTenantExportCompletion = async (input: {
  store: ReadStore;
  context: OperatorArtifactContext;
  worker: TenantExportWorkerInput;
}): Promise<
  | { status: "incomplete" }
  | { status: "unknown" }
  | {
      status: "complete";
      completion: TenantExportCompletion;
      manifest: TenantExportArtifactManifest;
      manifestBytes: Uint8Array;
    }
> => {
  try {
    const worker = tenantExportWorkerInputSchema.parse(input.worker);
    assertScope(input.context, worker);
    const marker = await input.store.read(input.context, markerRef(worker), 0);
    if (marker === undefined) {
      return { status: "incomplete" };
    }
    const raw: unknown = JSON.parse(marker);
    const completion = completionSchema.parse(raw);
    // A marker attests all page readbacks before publication. Reconciliation
    // checks it and the exact manifest, without rereading the full dataset.
    const envelope = await readManifestEnvelope({ ...input, worker, completion });
    return {
      status: "complete",
      completion,
      manifest: envelope.manifest,
      manifestBytes: envelope.bytes,
    };
  } catch {
    return { status: "unknown" };
  }
};

export const createTenantExportArtifacts = (dependencies: {
  store: OperatorArtifactStore;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}) => {
  const inspect = async (input: {
    context: OperatorArtifactContext;
    worker: TenantExportWorkerInput;
  }): Promise<TenantExportArtifactInspection> => {
    try {
      await dependencies.assertCurrentOwner(input.context);
    } catch {
      return { status: "unknown" };
    }
    const result = await inspectTenantExportCompletion({
      ...dependencies,
      ...input,
    });
    return result.status === "complete"
      ? { status: "complete", completion: result.completion }
      : result;
  };
  return {
    inspect,
    async publish(input: {
      context: OperatorArtifactContext;
      worker: TenantExportWorkerInput;
      source: TenantExportPrivateSource;
      assertCurrent: AssertCurrent;
    }): Promise<TenantExportCompletion> {
      const worker = tenantExportWorkerInputSchema.parse(input.worker);
      assertScope(input.context, worker);
      const assertCurrent = input.assertCurrent;
      await assertCurrent();
      const existing = await inspect({ ...input, worker });
      if (existing.status === "unknown") {
        throw operatorArtifactUnavailable();
      }
      if (existing.status === "complete") {
        await assertCurrent();
        return existing.completion;
      }
      await assertCurrent();
      const bytes = await input.source.readManifest();
      await assertCurrent();
      const manifest = parseTenantExportManifestForWorker(
        worker,
        tenantExportArtifactManifestSchema.parse(parsedJson(bytes)),
      );
      for (const file of manifest.files) {
        await publishMember({ ...dependencies, ...input, file, assertCurrent });
      }
      const manifestDigest = hash(bytes);
      const manifestMember: TenantExportCompletion["manifest"] = {
        kind: "manifest",
        name: "manifest.json",
        byteLength: String(bytes.byteLength),
        sha256: manifestDigest,
        artifactRef: `_protected-operator/artifacts/tenant-export/${worker.exportId}/${worker.attemptId}/manifest/${manifestDigest}`,
      };
      await publishBytes({
        ...dependencies,
        ...input,
        ...manifestMember,
        bytes: singleBytes(bytes),
        assertCurrent,
      });
      const completion: TenantExportCompletion = {
        attemptId: worker.attemptId,
        snapshotId: worker.snapshotId,
        manifest: manifestMember,
        fileCount: String(manifest.files.length),
        rowCount: manifest.rowCount,
        byteLength: manifest.byteLength,
      };
      await readTenantExportManifest({
        ...dependencies,
        ...input,
        worker,
        completion,
      });
      await writeVerified({
        ...dependencies,
        ...input,
        artifactRef: markerRef(worker),
        chunkIndex: 0,
        content: JSON.stringify(completionSchema.parse(completion)),
        assertCurrent,
      });
      return completion;
    },
  };
};
