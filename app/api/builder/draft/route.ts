import { getBuilderDraftDeploymentHandler } from "@/lib/builder-drafts/deployment";

/**
 * The page-hide transport for the browser autosave outbox. The handler shares
 * its validation and tenant authority with the Server Action used while active.
 */
export const POST = (request: Request) =>
  getBuilderDraftDeploymentHandler(process.env)(request);
