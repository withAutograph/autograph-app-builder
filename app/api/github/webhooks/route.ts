import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";
import { createGitHubProvisioningWebhookHandler } from "@/lib/provisioning/github-webhook";

let handler: ((request: Request) => Promise<Response>) | undefined;

// oxlint-disable-next-line sonarjs/function-name -- Next.js discovers this named HTTP method export.
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
