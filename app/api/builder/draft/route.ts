import { getBuilderDraftDeploymentHandler } from "@/lib/builder-drafts/deployment";

/**
 * The page-hide transport for the browser autosave outbox. The handler shares
 * its validation and tenant authority with the Server Action used while active.
 */
const post = async (request: Request) =>
  await getBuilderDraftDeploymentHandler(process.env)(request);

export { post as POST };
