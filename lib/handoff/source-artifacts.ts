import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { HostedDatabase } from "../db/hosted-postgres";
import { prototypeArtifactChunks } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { sourceCandidateReferenceSchema } from "./application-source-contract";
import { validateApplicationSourceArtifact } from "./application-source-bytes";

import {
  SOURCE_UPLOAD_CHUNK_BYTES,
  sourceUploadHeaderSchema,
  sourceUploadChunkSchema,
} from "./source-upload-protocol";

export {
  SOURCE_UPLOAD_CHUNK_BYTES,
  sourceUploadHeaderSchema,
  sourceUploadChunkSchema,
} from "./source-upload-protocol";
type Authority = z.infer<typeof hostedTenantAuthoritySchema>;
type Reference = z.infer<typeof sourceCandidateReferenceSchema>;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Header = z.infer<typeof sourceUploadHeaderSchema>;
export interface SourceArtifactChunkKey {
  authority: Authority;
  uploadId: string;
  path: string;
  transferDigest: string;
  chunkIndex: number;
}
export interface SourceArtifactChunkStorage {
  get: (key: SourceArtifactChunkKey) => Promise<string | undefined>;
  put: (key: SourceArtifactChunkKey, content: string) => Promise<void>;
}
const reference = (header: Header): Reference =>
  sourceCandidateReferenceSchema.parse({
    kind: header.kind,
    uploadId: header.uploadId,
    appId: header.appId,
    manifestDigest: header.manifestDigest,
  });
const key = (
  authority: Authority,
  uploadId: string,
  path: string,
  chunkIndex = 0,
  transferDigest = sha(`source-upload:v1:${uploadId}`),
): SourceArtifactChunkKey => ({
  authority: hostedTenantAuthoritySchema.parse(authority),
  uploadId: z.uuid().parse(uploadId),
  path,
  chunkIndex,
  transferDigest,
});
const same = (a: Reference, b: Reference) => JSON.stringify(a) === JSON.stringify(b);
export class SourceUploadError extends Error {
  name = "SourceUploadError";
  readonly code: "source_upload_conflict" | "source_upload_incomplete" | "source_upload_invalid";
  constructor(
    code: "source_upload_conflict" | "source_upload_incomplete" | "source_upload_invalid",
  ) {
    super(code);
    this.code = code;
  }
}

/** Separate source-only namespace: no prototype reader or native-session authority is widened. */
export const createImmutableSourceArtifactStore = (storage: SourceArtifactChunkStorage) => {
  const headerFor = async (authority: Authority, ref: Reference) => {
    const saved = await storage.get(key(authority, ref.uploadId, "source-handoff/reservation"));
    if (saved === undefined) {
      throw new SourceUploadError("source_upload_incomplete");
    }
    const header = sourceUploadHeaderSchema.parse(JSON.parse(saved));
    if (!same(reference(header), sourceCandidateReferenceSchema.parse(ref))) {
      throw new SourceUploadError("source_upload_conflict");
    }
    return header;
  };
  const readComplete = async (authority: Authority, ref: Reference) => {
    const header = await headerFor(authority, ref);
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Completion is meaningful only after validating the immutable owner-bound reservation.
    const marker = await storage.get(key(authority, ref.uploadId, "source-handoff/completion"));
    if (marker === undefined) {
      return globalThis.undefined;
    }
    if (marker !== JSON.stringify(header)) {
      throw new SourceUploadError("source_upload_conflict");
    }
    return header;
  };
  const readArtifact = async (authority: Authority, header: Header) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const hash = createHash("sha256");
    for (let index = 0; index < header.chunkCount; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Ordered reads bound memory while hashing the complete immutable payload.
      const encoded = await storage.get(
        key(authority, header.uploadId, "source-handoff/data", index, header.artifactDigest),
      );
      if (encoded === undefined) {
        throw new SourceUploadError("source_upload_incomplete");
      }
      const chunk = Buffer.from(encoded, "base64");
      if (chunk.toString("base64") !== encoded) {
        throw new SourceUploadError("source_upload_invalid");
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
    if (bytes !== header.artifactBytes || hash.digest("hex") !== header.artifactDigest) {
      throw new SourceUploadError("source_upload_invalid");
    }
    const parsed = validateApplicationSourceArtifact(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
    );
    if (
      parsed.manifestDigest !== header.manifestDigest ||
      parsed.artifact.manifest.appId !== header.appId
    ) {
      throw new SourceUploadError("source_upload_invalid");
    }
    return parsed.artifact;
  };
  return {
    async begin(input: { authority: Authority; header: Header }) {
      const header = sourceUploadHeaderSchema.parse(input.header);
      await storage.put(
        key(input.authority, header.uploadId, "source-handoff/reservation"),
        JSON.stringify(header),
      );
      await headerFor(input.authority, reference(header));
      return reference(header);
    },
    async put(input: {
      authority: Authority;
      reference: Reference;
      chunkIndex: number;
      contentBase64: string;
    }) {
      const chunk = sourceUploadChunkSchema.parse({
        reference: input.reference,
        chunkIndex: input.chunkIndex,
        contentBase64: input.contentBase64,
      });
      const header = await headerFor(input.authority, chunk.reference);
      const bytes = Buffer.from(chunk.contentBase64, "base64");
      const expected = Math.min(
        SOURCE_UPLOAD_CHUNK_BYTES,
        header.artifactBytes - chunk.chunkIndex * SOURCE_UPLOAD_CHUNK_BYTES,
      );
      if (
        chunk.chunkIndex >= header.chunkCount ||
        bytes.byteLength !== expected ||
        bytes.toString("base64") !== chunk.contentBase64
      ) {
        throw new SourceUploadError("source_upload_invalid");
      }
      await storage.put(
        key(
          input.authority,
          header.uploadId,
          "source-handoff/data",
          chunk.chunkIndex,
          header.artifactDigest,
        ),
        chunk.contentBase64,
      );
      return { chunkIndex: chunk.chunkIndex };
    },
    async complete(input: { authority: Authority; reference: Reference }) {
      const header = await headerFor(input.authority, input.reference);
      await readArtifact(input.authority, header);
      await storage.put(
        key(input.authority, header.uploadId, "source-handoff/completion"),
        JSON.stringify(header),
      );
      if ((await readComplete(input.authority, input.reference)) === undefined) {
        throw new SourceUploadError("source_upload_incomplete");
      }
      return reference(header);
    },
    async readCompleted(input: { authority: Authority; reference: Reference }) {
      const header = await readComplete(input.authority, input.reference);
      return header === undefined ? undefined : await readArtifact(input.authority, header);
    },
    async status(input: { authority: Authority; reference: Reference }) {
      return {
        status:
          (await readComplete(input.authority, input.reference)) === undefined
            ? ("uploading" as const)
            : ("complete" as const),
        reference: input.reference,
      };
    },
  };
};

export const createSourceArtifactStore = (db: HostedDatabase) => {
  const predicate = (k: SourceArtifactChunkKey) =>
    and(
      eq(prototypeArtifactChunks.issuer, k.authority.issuer),
      eq(prototypeArtifactChunks.audience, k.authority.audience),
      eq(prototypeArtifactChunks.workspaceId, k.authority.workspaceId),
      eq(prototypeArtifactChunks.ownerUserId, k.authority.ownerUserId),
      eq(prototypeArtifactChunks.sessionId, `source-upload:v1:${k.uploadId}`),
      eq(prototypeArtifactChunks.path, k.path),
      eq(prototypeArtifactChunks.transferDigest, k.transferDigest),
      eq(prototypeArtifactChunks.chunkIndex, k.chunkIndex),
    );
  const get = async (k: SourceArtifactChunkKey) => {
    const [row] = await db
      .select({
        content: prototypeArtifactChunks.content,
        chunkDigest: prototypeArtifactChunks.chunkDigest,
      })
      .from(prototypeArtifactChunks)
      .where(predicate(k));
    if (row === undefined) {
      return globalThis.undefined;
    }
    if (sha(row.content) !== row.chunkDigest) {
      throw new SourceUploadError("source_upload_invalid");
    }
    return row.content;
  };
  return createImmutableSourceArtifactStore({
    get,
    async put(k, content) {
      await db
        .insert(prototypeArtifactChunks)
        .values({
          ...k.authority,
          sessionId: `source-upload:v1:${k.uploadId}`,
          path: k.path,
          transferDigest: k.transferDigest,
          chunkIndex: k.chunkIndex,
          chunkDigest: sha(content),
          content,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
      if ((await get(k)) !== content) {
        throw new SourceUploadError("source_upload_conflict");
      }
    },
  });
};
