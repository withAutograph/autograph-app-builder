import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";
import { createGitHubProvisioningWebhookHandler } from "@/lib/provisioning/github-webhook";

export const runtime = "nodejs";

let handler: ((request: Request) => Promise<Response>) | undefined;

export const POST = (request: Request) => {
  try {
    handler ??= createGitHubProvisioningWebhookHandler({
      database: openHostedPostgresDatabase(
        readPreviewOAuthRuntimeConfig(process.env).databaseUrl,
      ),
      secret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
    });
    return handler(request);
  } catch {
    return Response.json(
      { error: "github_webhook_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
