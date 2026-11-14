import { createVercelWorkloadIdentity } from "@/lib/eve/vercel-workload-identity";
import { createDeploymentPrototypePreviewRequestHandler } from "@/lib/mcp/browser-preview-deployment";

const handler = createDeploymentPrototypePreviewRequestHandler({
  environment: process.env,
  workloadIdentity: createVercelWorkloadIdentity(),
});

// eslint-disable-next-line eslint/func-style, sonarjs/function-name -- Next requires a named HTTP-method export.
export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  return await handler.readDeliveryProgress(request, sessionId);
}
