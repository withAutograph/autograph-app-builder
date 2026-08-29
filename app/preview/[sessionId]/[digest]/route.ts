import { createVercelWorkloadIdentity } from "@/lib/eve/vercel-workload-identity";
import { createDeploymentPrototypePreviewRequestHandler } from "@/lib/mcp/browser-preview-deployment";

export const runtime = "nodejs";

const requestHandler = createDeploymentPrototypePreviewRequestHandler({
  environment: process.env,
  workloadIdentity: createVercelWorkloadIdentity(),
});

export async function GET(
  request: Request,
  context: {
    params: Promise<{ sessionId: string; digest: string }>;
  },
) {
  return requestHandler(request, await context.params);
}
