import { z } from "zod";
import { parseStrictBearerAuthorization } from "../mcp/request-auth";

export const hostedSessionResourceSchema = z.url().superRefine((value, ctx) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/mcp" ||
    [url.username, url.password, url.search, url.hash].some((part) => part !== "")
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Hosted session attachment requires an exact credential-free HTTPS /mcp resource.",
    });
  }
});
const requestHeaders = [
  "accept",
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];
const responseHeaders = [
  "content-type",
  "www-authenticate",
  "mcp-session-id",
  "mcp-protocol-version",
  "retry-after",
];
const failure = (status: number) =>
  Response.json(
    { error: "Hosted session relay is unavailable." },
    { status, headers: { "cache-control": "no-store" } },
  );

/**
 * Authenticated transport attachment only: forwards the caller's original
 * OAuth bearer to its pinned resource, never issues identity or runs local
 * agent code. No database, hosted workload credential, or token storage.
 */
export const createHostedSessionRelay = (input: {
  resourceUrl: string;
  fetchImplementation?: typeof fetch;
}) => {
  const resourceUrl = hostedSessionResourceSchema.parse(input.resourceUrl);
  const fetcher = input.fetchImplementation ?? fetch;
  return async (request: Request): Promise<Response> => {
    const local = new URL(request.url);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(local.hostname) ||
      local.username !== "" ||
      local.password !== ""
    ) {
      return failure(403);
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== local.origin) {
      return failure(403);
    }
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      try {
        parseStrictBearerAuthorization(authorization);
      } catch {
        return failure(401);
      }
    }
    const headers = new Headers();
    for (const name of requestHeaders) {
      const value = request.headers.get(name);
      if (value !== null) {
        headers.set(name, value);
      }
    }
    try {
      const upstream = await fetcher(resourceUrl, {
        method: "POST",
        headers,
        body: request.body,
        // Node's streaming request body requires duplex; no buffering of caller payloads.
        // @ts-expect-error Node's fetch extension is absent from the DOM RequestInit type.
        duplex: "half",
        redirect: "error",
        signal: request.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return failure(502);
      }
      const returned = new Headers({ "cache-control": "no-store" });
      for (const name of responseHeaders) {
        const value = upstream.headers.get(name);
        if (value !== null) {
          returned.set(name, value);
        }
      }
      return new Response(upstream.body, { status: upstream.status, headers: returned });
    } catch {
      return failure(502);
    }
  };
};
