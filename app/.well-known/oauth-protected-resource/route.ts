import {
  protectedResourceMetadata,
  readHostedMcpAuthConfig,
  unavailableResponse,
} from "@/lib/mcp/request-auth";

export const runtime = "nodejs";

export function GET(): Response {
  try {
    const metadata = protectedResourceMetadata(
      readHostedMcpAuthConfig(process.env),
    );
    return Response.json(metadata, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return unavailableResponse();
  }
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, X-Eve-Workspace-Id",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}
