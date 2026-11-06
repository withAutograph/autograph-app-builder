import { z } from "zod";
import { sourceCandidateReferenceSchema } from "./application-source-contract";

// Bound one source upload call below the Server Action envelope, not total app size.
export const SOURCE_UPLOAD_CHUNK_BYTES = 64 * 1024;
export const sourceUploadHeaderSchema = sourceCandidateReferenceSchema
  .extend({
    artifactBytes: z.number().int().positive(),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    chunkCount: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.chunkCount === Math.ceil(v.artifactBytes / SOURCE_UPLOAD_CHUNK_BYTES));
export const sourceUploadChunkSchema = z.object({
  chunkIndex: z.number().int().nonnegative(),
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil(SOURCE_UPLOAD_CHUNK_BYTES / 3) * 4),
  reference: sourceCandidateReferenceSchema,
});
