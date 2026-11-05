"use server";
/* oxlint-disable eslint/func-style -- Keep the existing named Server Action facade convention. */
import { headers } from "next/headers";
import type { SourceCandidateReference } from "@/lib/handoff/application-source-contract";
import type { z } from "zod";
import type {
  sourceUploadHeaderSchema,
  sourceUploadChunkSchema,
} from "@/lib/handoff/source-upload-protocol";
import {
  readAuthenticatedSourceUploadContext,
  createSourceUploadActions,
} from "@/lib/handoff/source-upload-deployment";

async function context() {
  return await readAuthenticatedSourceUploadContext({
    environment: process.env,
    headers: await headers(),
  });
}
const actions = createSourceUploadActions(context);
export async function beginBuilderSourceUpload(
  untrusted: z.input<typeof sourceUploadHeaderSchema>,
) {
  return await actions.begin(untrusted);
}
export async function putBuilderSourceUploadChunk(
  untrusted: z.input<typeof sourceUploadChunkSchema>,
) {
  return await actions.put(untrusted);
}
export async function completeBuilderSourceUpload(untrusted: SourceCandidateReference) {
  return await actions.complete(untrusted);
}
export async function readBuilderSourceUploadStatus(untrusted: SourceCandidateReference) {
  return await actions.status(untrusted);
}
