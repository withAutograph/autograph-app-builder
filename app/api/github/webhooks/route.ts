import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";
import { createGitHubProvisioningWebhookHandler } from "@/lib/provisioning/github-webhook";

let handler: ((request: Request) => Promise<Response>) | undefined;

/* oxlint-disable-next-line typescript/promise-function-async, sonarjs/function-name -- Preserve the handler's promise and synchronous exception behavior. Next.js discovers this named HTTP method export.
// react-doctor-disable-next-line react-doctor/webhook-signature-risk -- The delegated handler verifies the raw GitHub HMAC before parsing. */
export const POST = (request: Request) => {
  try {
    handler ??= createGitHubProvisioningWebhookHandler({
      database: openHostedPostgresDatabase(readPreviewOAuthRuntimeConfig(process.env).databaseUrl),
      secret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
    });
    return handler(request);
  } catch {
    return Response.json(
      { error: "github_webhook_unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
};
