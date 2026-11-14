import type { ToolContext } from "eve/tools";

import {
  repositoryProductionClientForContext,
  repositoryProductionSchemaReadbackError,
} from "./repository-production-client";

/** Read the installed schema through the existing protected session's app ownership. */
export const readInstalledSchemaPredecessor = async (appId: string, ctx: ToolContext) => {
  ctx.abortSignal.throwIfAborted();
  let client: Awaited<ReturnType<typeof repositoryProductionClientForContext>>;
  try {
    client = await repositoryProductionClientForContext(ctx);
  } catch {
    ctx.abortSignal.throwIfAborted();
    throw repositoryProductionSchemaReadbackError("owner-unavailable");
  }
  return await client.schemaPredecessor(appId);
};
