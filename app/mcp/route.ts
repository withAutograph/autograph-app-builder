import { createVercelWorkloadIdentity } from "@/lib/eve/vercel-workload-identity";
import { createDeploymentMcpRequestHandler } from "@/lib/mcp/hosted-route";

export const runtime = "nodejs";

/**
 * Construction acquires no credential and opens no connection. Hosted
 * capabilities are composed lazily inside the first hosted request, while the
 * authenticated principal and session service remain request-scoped. The MCP
 * adapter calls the canonical Eve routes emitted by withEve on this origin.
 */
const requestHandler = createDeploymentMcpRequestHandler({
  environment: process.env,
  workloadIdentity: createVercelWorkloadIdentity(),
});

export { requestHandler as POST };
