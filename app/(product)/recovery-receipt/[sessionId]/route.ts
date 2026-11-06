import { createVercelWorkloadIdentity } from "@/lib/eve/vercel-workload-identity";
import { createDeploymentPrototypePreviewRequestHandler } from "@/lib/mcp/browser-preview-deployment";

const handler = createDeploymentPrototypePreviewRequestHandler({
  environment: process.env,
  workloadIdentity: createVercelWorkloadIdentity(),
});

// eslint-disable-next-line eslint/func-style, sonarjs/function-name -- Next requires a named HTTP-method export.
export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const params = new URL(request.url).searchParams;
  const logicalSessionId = params.get("logicalSessionId") ?? "";
  const ownerRunId = params.get("ownerRunId") ?? "";
  const runId = /^wrun_[A-Za-z0-9]{1,195}$/u;
  if (!runId.test(logicalSessionId) || !runId.test(ownerRunId)) {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return await handler.readRecoveryReceipt(request, { sessionId, logicalSessionId, ownerRunId });
}
