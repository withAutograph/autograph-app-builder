import { createHash } from "node:crypto";

import type { PrototypeArtifactV2 } from "./workflow-state";
import {
  expectedPrototypeArtifactMediaType,
  parsePrototypeArtifactPath,
} from "./prototype-artifacts";
import { verifyPrototypeArtifactManifest } from "./prototype-artifact-stream";
import { EVE_MAX_PAYLOAD_BYTES } from "../eve/payload-envelope";

const sha256 = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");

export interface DurablePrototypeChunkStore {
  put: (input: {
    path: string;
    transferDigest: string;
    chunkIndex: number;
    content: string;
  }) => Promise<string>;
  get: (input: {
    path: string;
    transferDigest: string;
    chunkIndex: number;
  }) => Promise<string | undefined>;
}

export interface DurablePrototypeChunkInput {
  current?: PrototypeArtifactV2;
  appId: string;
  path: string;
  mediaType: "text/html" | "text/markdown";
  sessionId: string;
  callId: string;
  content: string;
  expectedDigest: string;
  chunkIndex: number;
  finalChunk: boolean;
  baseRevision?: string;
  store: DurablePrototypeChunkStore;
}

export interface DurablePrototypeChunkResult {
  artifact: PrototypeArtifactV2;
  complete: boolean;
  nextChunkIndex: number;
  reused: boolean;
}

/** The tool emits metadata only; complete receipts are eligible for public ref projection. */
export const durablePrototypeToolReceipt = (result: DurablePrototypeChunkResult) => {
  const { transfer, lastChunkReceipt, ...manifest } = result.artifact;
  void transfer;
  void lastChunkReceipt;
  return {
    ...manifest,
    complete: result.complete,
    nextChunkIndex: result.nextChunkIndex,
    reused: result.reused,
    size: result.artifact.contentBytes,
  };
};

/** Store one ordered chunk, then publish only a digest-verified manifest to Eve state. */
// oxlint-disable sonarjs/expression-complexity -- Exact retry and stale-revision checks require all receipt fields.
// oxlint-disable-next-line eslint/complexity -- Transfer validation and receipt publication share one atomic decision path.
export const recordDurablePrototypeChunk = async (
  input: DurablePrototypeChunkInput,
): Promise<DurablePrototypeChunkResult> => {
  const { appId } = parsePrototypeArtifactPath(input.path);
  if (appId !== input.appId || expectedPrototypeArtifactMediaType(input.path) !== input.mediaType) {
    throw new Error("The durable prototype artifact identity is invalid.");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.expectedDigest)) {
    throw new Error("The durable prototype artifact identity is invalid.");
  }
  if (
    input.content.length === 0 ||
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0
  ) {
    throw new Error("The durable prototype artifact chunk is invalid.");
  }
  if (input.sessionId.length === 0 || input.callId.length === 0) {
    throw new Error("The durable prototype artifact chunk is invalid.");
  }
  const prior = input.current;
  if (prior && (prior.path !== input.path || prior.sessionId !== input.sessionId)) {
    throw new Error("The prototype artifact belongs to a different session or path.");
  }
  const chunkDigest = sha256(input.content);
  if (
    prior &&
    prior.lastChunkReceipt?.expectedDigest === input.expectedDigest &&
    prior.lastChunkReceipt.lastChunkIndex === input.chunkIndex &&
    prior.lastChunkReceipt.lastChunkDigest === chunkDigest &&
    prior.lastChunkReceipt.lastCallId === input.callId
  ) {
    return { artifact: prior, complete: true, nextChunkIndex: input.chunkIndex + 1, reused: true };
  }
  const transfer = prior?.transfer;
  if (
    prior &&
    transfer?.expectedDigest === input.expectedDigest &&
    transfer.nextChunkIndex - 1 === input.chunkIndex &&
    transfer.lastChunkDigest === chunkDigest &&
    transfer.lastCallId === input.callId
  ) {
    return {
      artifact: prior,
      complete: false,
      nextChunkIndex: transfer.nextChunkIndex,
      reused: true,
    };
  }
  const restart = input.chunkIndex === 0 && transfer?.expectedDigest !== input.expectedDigest;
  if (
    !restart &&
    transfer &&
    (transfer.expectedDigest !== input.expectedDigest ||
      transfer.nextChunkIndex !== input.chunkIndex ||
      prior?.revision !== input.baseRevision)
  ) {
    throw new Error("The durable prototype chunk is out of order or its base revision is stale.");
  }
  if (!transfer && input.chunkIndex !== 0) {
    throw new Error("A durable prototype transfer must start with chunk zero.");
  }
  const previous = restart ? undefined : transfer;
  const bytes = (previous?.receivedBytes ?? 0) + Buffer.byteLength(input.content, "utf-8");
  if (!Number.isSafeInteger(bytes)) {
    throw new TypeError("The prototype artifact byte count exceeds the provider's integer range.");
  }
  const storedChunkDigest = await input.store.put({
    chunkIndex: input.chunkIndex,
    content: input.content,
    path: input.path,
    transferDigest: input.expectedDigest,
  });
  if (storedChunkDigest !== chunkDigest) {
    throw new Error("The durable prototype store returned a different chunk digest.");
  }
  const nextChunkIndex = input.chunkIndex + 1;
  const rollingDigest = sha256(`${previous?.rollingDigest ?? ""}${chunkDigest}`);
  if (!input.finalChunk) {
    const nextTransfer = {
      expectedDigest: input.expectedDigest,
      lastCallId: input.callId,
      lastChunkDigest: chunkDigest,
      nextChunkIndex,
      receivedBytes: bytes,
      rollingDigest,
      version: 2 as const,
    };
    const artifact: PrototypeArtifactV2 = {
      appId,
      chunkCount: nextChunkIndex,
      contentBytes: bytes,
      digest: rollingDigest,
      mediaType: input.mediaType,
      path: input.path,
      recordedByCallId: input.callId,
      revision: sha256(
        JSON.stringify({
          digest: rollingDigest,
          mediaType: input.mediaType,
          path: input.path,
          transfer: nextTransfer,
        }),
      ),
      sessionId: input.sessionId,
      transfer: nextTransfer,
      version: 2,
    };
    return { artifact, complete: false, nextChunkIndex, reused: false };
  }
  const artifact: PrototypeArtifactV2 = {
    appId,
    chunkCount: nextChunkIndex,
    contentBytes: bytes,
    digest: input.expectedDigest,
    lastChunkReceipt: {
      expectedDigest: input.expectedDigest,
      lastCallId: input.callId,
      lastChunkDigest: chunkDigest,
      lastChunkIndex: input.chunkIndex,
    },
    mediaType: input.mediaType,
    path: input.path,
    recordedByCallId: input.callId,
    revision: sha256(
      JSON.stringify({
        digest: input.expectedDigest,
        mediaType: input.mediaType,
        path: input.path,
      }),
    ),
    sessionId: input.sessionId,
    version: 2,
  };
  await verifyPrototypeArtifactManifest({
    artifact,
    // oxlint-disable-next-line typescript/promise-function-async -- The store read already returns a Promise.
    readChunk: (chunkIndex) =>
      input.store.get({
        chunkIndex,
        path: input.path,
        transferDigest: input.expectedDigest,
      }),
  });
  return { artifact, complete: true, nextChunkIndex, reused: false };
};
// oxlint-enable sonarjs/expression-complexity

/** Persist generated HTML incrementally; one Eve state update can publish the final manifest. */
export const recordDurablePrototypeContent = async (input: {
  appId: string;
  callId: string;
  content: string;
  path: string;
  sessionId: string;
  store: DurablePrototypeChunkStore;
  chunkBytes?: number;
}): Promise<DurablePrototypeChunkResult> => {
  const chunkBytes = input.chunkBytes ?? Math.floor(EVE_MAX_PAYLOAD_BYTES / 8);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4 || input.content.length === 0) {
    throw new Error("The durable prototype content or chunk size is invalid.");
  }
  const expectedDigest = sha256(input.content);
  let pending = "";
  let pendingBytes = 0;
  let current: PrototypeArtifactV2 | undefined;
  let chunkIndex = 0;
  const write = async (content: string, finalChunk: boolean) => {
    const chunkInput: DurablePrototypeChunkInput = {
      appId: input.appId,
      callId: input.callId,
      chunkIndex,
      content,
      expectedDigest,
      finalChunk,
      mediaType: "text/html",
      path: input.path,
      sessionId: input.sessionId,
      store: input.store,
    };
    if (current !== undefined) {
      chunkInput.baseRevision = current.revision;
      chunkInput.current = current;
    }
    const result = await recordDurablePrototypeChunk(chunkInput);
    current = result.artifact;
    chunkIndex += 1;
    return result;
  };
  for (const point of input.content) {
    const pointBytes = Buffer.byteLength(point, "utf-8");
    if (pendingBytes + pointBytes > chunkBytes && pending.length > 0) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each chunk's receipt binds the next write.
      await write(pending, false);
      pending = "";
      pendingBytes = 0;
    }
    pending += point;
    pendingBytes += pointBytes;
  }
  return await write(pending, true);
};
