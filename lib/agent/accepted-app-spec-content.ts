import type { AcceptedAppSpec, StoredPrototypeArtifact } from "./workflow-state";
import { isPrototypeArtifactV2 } from "./prototype-artifacts";
import { readAcceptedAppSpecContent } from "./accepted-app-spec-stream";
import { streamVerifiedPrototypeArtifact } from "./prototype-artifact-stream";
import { createHostedPrototypeChunkStore } from "./hosted-prototype-chunk-store";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";

interface ReferenceInput {
  accepted: AcceptedAppSpec;
  artifacts: readonly StoredPrototypeArtifact[];
  sessionAuth: unknown;
  sessionId: string;
}

const exactDurableReference = (input: ReferenceInput) => {
  const artifact = input.artifacts.find(
    (candidate) =>
      candidate.path === input.accepted.artifactPath &&
      candidate.revision === input.accepted.artifactRevision &&
      candidate.sessionId === input.sessionId,
  );
  if (
    artifact === undefined ||
    !isPrototypeArtifactV2(artifact) ||
    artifact.digest !== input.accepted.digest
  ) {
    throw new Error("The accepted AppSpec artifact is unavailable in this session.");
  }
  const store = createHostedPrototypeChunkStore({
    db: openHostedPostgresDatabase(process.env.DATABASE_URL ?? ""),
    sessionAuth: input.sessionAuth,
    sessionId: input.sessionId,
  });
  return {
    artifact,
    readChunk: async (chunkIndex: number) =>
      await store.get({
        chunkIndex,
        path: artifact.path,
        transferDigest: artifact.digest,
      }),
  };
};

export const resolveAcceptedAppSpecStream = (input: ReferenceInput): ReadableStream<Uint8Array> => {
  if (input.accepted.version !== 2) {
    throw new Error("The accepted AppSpec does not have a durable stream reference.");
  }
  const iterator = streamVerifiedPrototypeArtifact(exactDurableReference(input));
  return new ReadableStream<Uint8Array>({
    async cancel() {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- AsyncGenerator.return requires a value in this TypeScript version.
      await iterator.return(undefined);
    },
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
  });
};

/** Reopen an exact verified text stream for each independent source-review page.
 * @yields {string} A UTF-8-safe piece of the verified AppSpec.
 */
// oxlint-disable-next-line eslint/func-style -- Async generator preserves read backpressure.
export async function* acceptedAppSpecTextParts(input: ReferenceInput): AsyncGenerator<string> {
  if (input.accepted.version !== 2) {
    throw new Error("The accepted AppSpec does not have a durable stream reference.");
  }
  const decoder = new TextDecoder();
  for await (const bytes of streamVerifiedPrototypeArtifact(exactDurableReference(input))) {
    const text = decoder.decode(bytes, { stream: true });
    if (text.length > 0) {
      yield text;
    }
  }
  const final = decoder.decode();
  if (final.length > 0) {
    yield final;
  }
}

/** Resolve the exact accepted content only for a consumer that needs bytes. */
export const resolveAcceptedAppSpecContent = async (input: ReferenceInput): Promise<string> => {
  if (input.accepted.version !== 2) {
    if (input.accepted.content === undefined) {
      throw new Error("The legacy accepted AppSpec content is unavailable.");
    }
    return input.accepted.content;
  }
  return await readAcceptedAppSpecContent({
    accepted: input.accepted,
    ...exactDurableReference(input),
  });
};
