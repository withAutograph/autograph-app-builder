import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";
import { createGitHubProvisioningWebhookHandler } from "@/lib/provisioning/github-webhook";

let handler: ((request: Request) => Promise<Response>) | undefined;

const handlePost = async (request: Request): Promise<Response> => {
  try {
    handler ??= createGitHubProvisioningWebhookHandler({
      database: openHostedPostgresDatabase(readPreviewOAuthRuntimeConfig(process.env).databaseUrl),
      secret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
    });
    return await handler(request);
  } catch {
    return Response.json(
      { error: "github_webhook_unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
};

export { handlePost as POST };
