import { createVercelWorkloadIdentity } from "@/lib/eve/vercel-workload-identity";
import { createDeploymentPrototypePreviewRequestHandler } from "@/lib/mcp/browser-preview-deployment";

const requestHandler = createDeploymentPrototypePreviewRequestHandler({
  environment: process.env,
  workloadIdentity: createVercelWorkloadIdentity(),
});

const handleGet = async (
  request: Request,
  context: {
    params: Promise<{ sessionId: string; digest: string }>;
  },
) => await requestHandler(request, await context.params);

export { handleGet as GET };
