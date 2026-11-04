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
  if (after === undefined || JSON.stringify(before.authority) !== JSON.stringify(after.authority)) {
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
