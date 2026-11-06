import type { z } from "zod";
import {
  applicationSourceArtifactSchema,
  sourceCandidateReferenceSchema,
} from "./application-source-contract";
import type { sourceUploadHeaderSchema, sourceUploadChunkSchema } from "./source-upload-protocol";
import { SOURCE_UPLOAD_CHUNK_BYTES } from "./source-upload-protocol";

type Reference = z.infer<typeof sourceCandidateReferenceSchema>;
export interface SourceUploadClientPorts {
  begin: (header: z.infer<typeof sourceUploadHeaderSchema>) => Promise<Reference>;
  put: (chunk: z.infer<typeof sourceUploadChunkSchema>) => Promise<{ chunkIndex: number }>;
  complete: (reference: Reference) => Promise<Reference>;
  status: (
    reference: Reference,
  ) => Promise<{ status: "complete" | "uploading"; reference: Reference }>;
}
const hash = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const base64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCodePoint(byte);
  }
  return btoa(text);
};
/** Ordinary source upload only. Unknown completion is read back under the same immutable upload ID. */
export const uploadApplicationSource = async (input: {
  file: Pick<File, "arrayBuffer">;
  ports: SourceUploadClientPorts;
  uploadIdForDigest: (digest: string) => string;
  onProgress?: (text: string) => void;
}) => {
  const bytes = await input.file.arrayBuffer();
  const artifact = applicationSourceArtifactSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  const artifactDigest = await hash(bytes);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(artifact.manifest));
  const manifestDigest = await hash(manifestBytes.buffer);
  const declared = {
    appId: artifact.manifest.appId,
    artifactBytes: bytes.byteLength,
    artifactDigest,
    chunkCount: Math.ceil(bytes.byteLength / SOURCE_UPLOAD_CHUNK_BYTES),
    kind: "application-source-candidate-v1" as const,
    manifestDigest,
    uploadId: input.uploadIdForDigest(artifactDigest),
  };
  const reference = await input.ports.begin(declared);
  if (
    JSON.stringify(reference) !==
    JSON.stringify(
      sourceCandidateReferenceSchema.parse({
        appId: declared.appId,
        kind: declared.kind,
        manifestDigest: declared.manifestDigest,
        uploadId: declared.uploadId,
      }),
    )
  ) {
    throw new Error("source_upload_conflict");
  }
  for (
    let index = 0, offset = 0;
    offset < bytes.byteLength;
    offset += SOURCE_UPLOAD_CHUNK_BYTES, index += 1
  ) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Ordered bounded chunks provide upload backpressure and same-ID retry progress.
    await input.ports.put({
      chunkIndex: index,
      contentBase64: base64(
        new Uint8Array(bytes.slice(offset, offset + SOURCE_UPLOAD_CHUNK_BYTES)),
      ),
      reference,
    });
    input.onProgress?.(
      `Uploaded ${Math.min(offset + SOURCE_UPLOAD_CHUNK_BYTES, bytes.byteLength)} of ${bytes.byteLength} bytes`,
    );
  }
  let completed: Reference;
  try {
    completed = await input.ports.complete(reference);
  } catch (error) {
    const observed = await input.ports.status(reference);
    if (observed.status !== "complete") {
      throw error;
    }
    completed = observed.reference;
  }
  if (JSON.stringify(completed) !== JSON.stringify(reference)) {
    throw new Error("source_upload_conflict");
  }
  return {
    displayName: artifact.manifest.displayName,
    omissions: artifact.manifest.omissions.length,
    reference: completed,
  };
};
