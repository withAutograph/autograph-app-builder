import { createMcpRequestHandler } from "@/lib/mcp/request-handler";

export const runtime = "nodejs";

/**
 * The module-level handler contains no principal or session service. It selects
 * and constructs the service independently inside every HTTP request.
 */
const requestHandler = createMcpRequestHandler();

export { requestHandler as GET, requestHandler as POST };
