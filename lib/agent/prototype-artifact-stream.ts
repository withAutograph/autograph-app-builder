import { createHash } from "node:crypto";

import type { PrototypeArtifactV2 } from "./workflow-state";
import {
  expectedPrototypeArtifactMediaType,
  parsePrototypeArtifactPath,
} from "./prototype-artifacts";
import { largestUtf8PayloadChunk } from "../eve/payload-envelope";

export type ReadPrototypeChunk = (index: number) => Promise<string | undefined>;
const invalidManifest = "The prototype artifact manifest is incomplete or invalid.";

/** Validate an immutable v2 manifest before any artifact bytes reach a Browser response. */
export const verifyPrototypeArtifactManifest = async (input: {
  artifact: PrototypeArtifactV2;
  readChunk: ReadPrototypeChunk;
}): Promise<void> => {
  const { artifact } = input;
  parsePrototypeArtifactPath(artifact.path);
  const sha256 = /^[0-9a-f]{64}$/u;
  if (artifact.version !== 2 || !sha256.test(artifact.digest) || !sha256.test(artifact.revision)) {
    throw new Error(invalidManifest);
  }
  if (
    expectedPrototypeArtifactMediaType(artifact.path) !== artifact.mediaType ||
    !Number.isSafeInteger(artifact.chunkCount) ||
    artifact.chunkCount < 1
  ) {
    throw new Error(invalidManifest);
  }
  if (
    !Number.isSafeInteger(artifact.contentBytes) ||
    artifact.contentBytes < 1 ||
    artifact.transfer !== undefined
  ) {
    throw new Error(invalidManifest);
  }
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        digest: artifact.digest,
        mediaType: artifact.mediaType,
        path: artifact.path,
      }),
    )
    .digest("hex");
  if (revision !== artifact.revision) {
    throw new Error("The prototype artifact revision does not match its manifest.");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for (let index = 0; index < artifact.chunkCount; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Ordered digest verification uses bounded memory.
    const content = await input.readChunk(index);
    if (content === undefined || content.length === 0) {
      throw new Error(
        `The prototype artifact is missing chunk ${index}. Retry the saved session or restore the durable chunk.`,
      );
    }
    bytes += Buffer.byteLength(content, "utf-8");
    if (!Number.isSafeInteger(bytes) || bytes > artifact.contentBytes) {
      throw new Error("The prototype artifact chunk lengths do not match its manifest.");
    }
    hash.update(content, "utf-8");
  }
  if (bytes !== artifact.contentBytes || hash.digest("hex") !== artifact.digest) {
    throw new Error("The prototype artifact content digest does not match its manifest.");
  }
};

/** Read a verified manifest in a second pass; the store's write-once chunks cannot change.
 * @yields {Uint8Array} One UTF-8 encoded chunk at a time.
 */
// oxlint-disable-next-line eslint/func-style -- Async generators require a declaration here.
export async function* streamVerifiedPrototypeArtifact(input: {
  artifact: PrototypeArtifactV2;
  readChunk: ReadPrototypeChunk;
}): AsyncGenerator<Uint8Array> {
  await verifyPrototypeArtifactManifest(input);
  for (let index = 0; index < input.artifact.chunkCount; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- The stream consumer controls read backpressure.
    const content = await input.readChunk(index);
    if (content === undefined || content.length === 0) {
      throw new Error(`The prototype artifact is missing chunk ${index} after verification.`);
    }
    yield Buffer.from(content, "utf-8");
  }
}

/** Read one Eve-safe v2 chunk by global UTF-8 byte offset without materializing the artifact. */
export const readVerifiedPrototypeArtifactChunk = async (input: {
  artifact: PrototypeArtifactV2;
  readChunk: ReadPrototypeChunk;
  offsetBytes: number;
}) => {
  if (
    !Number.isSafeInteger(input.offsetBytes) ||
    input.offsetBytes < 0 ||
    input.offsetBytes >= input.artifact.contentBytes
  ) {
    throw new Error("The prototype artifact byte offset is outside the recorded content.");
  }
  await verifyPrototypeArtifactManifest(input);
  let start = 0;
  for (let index = 0; index < input.artifact.chunkCount; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Offset lookup is ordered and bounded by one chunk.
    const content = await input.readChunk(index);
    if (content === undefined) {
      throw new Error(`The prototype artifact is missing chunk ${index}.`);
    }
    const end = start + Buffer.byteLength(content, "utf-8");
    if (input.offsetBytes < end) {
      const localOffset = input.offsetBytes - start;
      const chunkStart = start;
      return largestUtf8PayloadChunk({
        content,
        makePayload(piece, nextLocalOffset) {
          const nextOffsetBytes = chunkStart + nextLocalOffset;
          const output = {
            byteOffset: input.offsetBytes,
            chunkDigest: createHash("sha256").update(piece, "utf-8").digest("hex"),
            complete: nextOffsetBytes === input.artifact.contentBytes,
            content: piece,
            digest: input.artifact.digest,
            mediaType: input.artifact.mediaType,
            nextOffsetBytes,
            path: input.artifact.path,
            revision: input.artifact.revision,
            totalBytes: input.artifact.contentBytes,
          };
          return {
            data: { result: { kind: "tool-result", output, toolName: "get_prototype_artifact" } },
            type: "action.result",
          };
        },
        offsetBytes: localOffset,
      }).payload.data.result.output;
    }
    start = end;
  }
  throw new Error("The prototype artifact byte offset is outside the recorded content.");
};
