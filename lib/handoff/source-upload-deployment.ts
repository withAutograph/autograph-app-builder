import { sourceCandidateReferenceSchema } from "./application-source-contract";
import { sourceUploadHeaderSchema, sourceUploadChunkSchema } from "./source-upload-protocol";
import type { z } from "zod";
import { getAuthenticatedBuilderDraftContext } from "../builder-drafts/deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { createSourceArtifactStore } from "./source-artifacts";

interface Context {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  store: ReturnType<typeof createSourceArtifactStore>;
}
/** Recheck active membership after I/O, before exposing any source or completion receipt. */
export const withSourceUploadAuthority = async <T>(
  readContext: () => Promise<Context | undefined>,
  operation: (context: Context) => Promise<T>,
): Promise<T> => {
  const before = await readContext();
  if (before === undefined) {
    throw new Error("source_upload_authentication_required");
  }
  const result = await operation(before);
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Membership must be checked after I/O, never in parallel with it.
  const after = await readContext();
  if (
    after === undefined ||
    [
      before.authority.issuer,
      before.authority.audience,
      before.authority.workspaceId,
      before.authority.ownerUserId,
    ].join("\0") !==
      [
        after.authority.issuer,
        after.authority.audience,
        after.authority.workspaceId,
        after.authority.ownerUserId,
      ].join("\0")
  ) {
    throw new Error("source_upload_authentication_required");
  }
  return result;
};
export const readAuthenticatedSourceUploadContext = async (input: {
  environment: NodeJS.ProcessEnv;
  headers: Headers;
}): Promise<Context | undefined> => {
  const context = await getAuthenticatedBuilderDraftContext(input);
  if (context === undefined) {
    return undefined;
  }
  const config = readPreviewOAuthRuntimeConfig(input.environment);
  return {
    authority: context.authority,
    store: createSourceArtifactStore(openHostedPostgresDatabase(config.databaseUrl)),
  };
};

/** The same closed action service is used by Next's authenticated Server Action facade. */
export const createSourceUploadActions = (readContext: () => Promise<Context | undefined>) => ({
  async begin(untrusted: z.input<typeof sourceUploadHeaderSchema>) {
    const header = sourceUploadHeaderSchema.parse(untrusted);
    return await withSourceUploadAuthority(
      readContext,
      async ({ authority, store }) => await store.begin({ authority, header }),
    );
  },
  async complete(untrusted: z.input<typeof sourceCandidateReferenceSchema>) {
    const reference = sourceCandidateReferenceSchema.parse(untrusted);
    return await withSourceUploadAuthority(
      readContext,
      async ({ authority, store }) => await store.complete({ authority, reference }),
    );
  },
  async put(untrusted: z.input<typeof sourceUploadChunkSchema>) {
    const input = sourceUploadChunkSchema.parse(untrusted);
    return await withSourceUploadAuthority(
      readContext,
      async ({ authority, store }) => await store.put({ authority, ...input }),
    );
  },
  async status(untrusted: z.input<typeof sourceCandidateReferenceSchema>) {
    const reference = sourceCandidateReferenceSchema.parse(untrusted);
    return await withSourceUploadAuthority(
      readContext,
      async ({ authority, store }) => await store.status({ authority, reference }),
    );
  },
});
