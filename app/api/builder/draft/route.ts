import { getBuilderDraftDeploymentHandler } from "@/lib/builder-drafts/deployment";

/**
 * The page-hide transport for the browser autosave outbox. The handler shares
 * its validation and tenant authority with the Server Action used while active.
 */
// oxlint-disable-next-line sonarjs/function-name -- Next.js discovers this named HTTP method export.
export const POST = (request: Request) => getBuilderDraftDeploymentHandler(process.env)(request);
