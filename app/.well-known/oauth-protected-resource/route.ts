import { readHostedMcpAuthConfig } from "../../../lib/mcp/request-auth";

const getMetadata = (): Response => {
  try {
    const environment: Record<string, string | undefined> = {};
    for (const key of [
      "MCP_OAUTH_ALGORITHM",
      "MCP_OAUTH_AUDIENCE",
      "MCP_OAUTH_ISSUER",
      "MCP_OAUTH_JWKS_URL",
      "MCP_RESOURCE_URL",
    ]) {
      environment[key] = process.env[key];
    }
    const config = readHostedMcpAuthConfig(environment);
    const metadata = {
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      resource: config.resourceUrl,
      scopes_supported: [
        "autograph:session",
        "autograph:start",
        "autograph:get",
        "autograph:send",
        "autograph:respond",
        "autograph:cancel",
      ],
    };
    return Response.json(metadata, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return Response.json(
      { error: "service_unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
};

export const GET = getMetadata;

const getOptions = (): Response =>
  new Response(null, {
    headers: {
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
    },
    status: 204,
  });

export const OPTIONS = getOptions;
