import {
  protectedResourceMetadata,
  readHostedMcpAuthConfig,
  unavailableResponse,
} from "@/lib/mcp/request-auth";

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- Next.js discovers this named HTTP method export. Preserve function declaration hoisting and initialization timing.
export function GET(): Response {
  try {
    const metadata = protectedResourceMetadata(readHostedMcpAuthConfig(process.env));
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

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- Next.js discovers this named HTTP method export. Preserve function declaration hoisting and initialization timing.
export function OPTIONS(): Response {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
    },
    status: 204,
  });
}
