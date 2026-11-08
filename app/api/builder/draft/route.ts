import { getBuilderDraftDeploymentHandler } from "@/lib/builder-drafts/deployment";

/**
 * The page-hide transport for the browser autosave outbox. The handler shares
 * its validation and tenant authority with the Server Action used while active.
 */
// oxlint-disable-next-line typescript/promise-function-async, sonarjs/function-name -- Preserve the handler's promise and synchronous exception behavior. Next.js discovers this named HTTP method export.
export const POST = (request: Request) => getBuilderDraftDeploymentHandler(process.env)(request);
