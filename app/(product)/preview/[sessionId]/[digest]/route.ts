import { createVercelWorkloadIdentity } from "@/lib/eve/vercel-workload-identity";
import { createDeploymentPrototypePreviewRequestHandler } from "@/lib/mcp/browser-preview-deployment";

const requestHandler = createDeploymentPrototypePreviewRequestHandler({
  environment: process.env,
  workloadIdentity: createVercelWorkloadIdentity(),
});

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- Next.js discovers this named HTTP method export. Preserve function declaration hoisting and initialization timing.
export async function GET(
  request: Request,
  context: {
    params: Promise<{ sessionId: string; digest: string }>;
  },
) {
  return await requestHandler(request, await context.params);
}
