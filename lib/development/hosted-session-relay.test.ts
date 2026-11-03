/* oxlint-disable eslint/require-await -- Controlled upstream async ports expose exact HTTP exchanges without provider access. */
import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { z } from "zod";
import { createHostedSessionRelay, hostedSessionResourceSchema } from "./hosted-session-relay";

const resource = "https://builder.example/mcp";
const downstream = "http://127.0.0.1:3111/mcp/hosted";
const call = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: {
    name: "autograph_get",
    arguments: { sessionId: "retained-session", cursor: "retained-cursor" },
  },
});

describe("local hosted-session transport attachment", () => {
  it.each([
    "http://builder.example/mcp",
    "https://user:secret@builder.example/mcp",
    "https://builder.example/other",
    "https://builder.example/mcp?token=secret",
    "https://builder.example/mcp#fragment",
  ])("rejects an unpinned resource %s", (url) => {
    expect(hostedSessionResourceSchema.safeParse(url).success).toBe(false);
  });
  it("forwards the original session/cursor and caller OAuth bearer without cookies or workload impersonation", async () => {
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer controlled-caller-token");
      expect(headers.get("mcp-session-id")).toBe("transport-session");
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBeNull();
      expect(headers.get("x-forwarded-host")).toBeNull();
      expect(init?.redirect).toBe("error");
      expect(await new Response(init?.body).text()).toBe(call);
      return new Response('data: {"result":{"sessionId":"retained-session"}}\n\n', {
        headers: {
          "content-type": "text/event-stream",
          "mcp-session-id": "transport-session",
          "set-cookie": "never-copy=secret",
        },
      });
    });
    const handler = createHostedSessionRelay({
      resourceUrl: resource,
      fetchImplementation: upstream,
    });
    const response = await handler(
      new Request(downstream, {
        method: "POST",
        body: call,
        headers: {
          authorization: "Bearer controlled-caller-token",
          cookie: "never-forward=secret",
          "mcp-session-id": "transport-session",
          "x-vercel-trusted-oidc-idp-token": "never-forward-workload",
          "x-forwarded-host": "untrusted",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      }),
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(resource);
    expect(response.headers.get("mcp-session-id")).toBe("transport-session");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain('"sessionId":"retained-session"');
  });
  it("preserves the canonical OAuth challenge for normal client authentication", async () => {
    const challenge =
      'Bearer resource_metadata="https://builder.example/.well-known/oauth-protected-resource/mcp"';
    const handler = createHostedSessionRelay({
      resourceUrl: resource,
      fetchImplementation: async () =>
        new Response(null, { status: 401, headers: { "www-authenticate": challenge } }),
    });
    const response = await handler(new Request(downstream, { method: "POST", body: call }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(challenge);
  });
  it.each([
    new Request("https://remote.example/mcp/hosted", { method: "POST", body: call }),
    new Request(downstream, {
      method: "POST",
      body: call,
      headers: { origin: "https://remote.example" },
    }),
    new Request(downstream, { method: "GET" }),
    new Request(downstream, {
      method: "POST",
      body: call,
      headers: { authorization: "Bearer first, Bearer second" },
    }),
  ])("refuses unsupported ingress before forwarding", async (request) => {
    const upstream = vi.fn<typeof fetch>();
    const response = await createHostedSessionRelay({
      resourceUrl: resource,
      fetchImplementation: upstream,
    })(request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("does not follow upstream redirects or expose network diagnostics", async () => {
    const moved = createHostedSessionRelay({
      resourceUrl: resource,
      fetchImplementation: async () =>
        new Response(null, { status: 307, headers: { location: "https://other.example/mcp" } }),
    });
    const movedResponse = await moved(new Request(downstream, { method: "POST", body: call }));
    expect(movedResponse.status).toBe(502);
    const failed = createHostedSessionRelay({
      resourceUrl: resource,
      fetchImplementation: async () => {
        throw new Error("private transport detail");
      },
    });
    const response = await failed(new Request(downstream, { method: "POST", body: call }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private transport detail");
  });
  it("serves a real loopback HTTP request using the same original public tool payload", async () => {
    const handler = createHostedSessionRelay({
      resourceUrl: resource,
      fetchImplementation: async (_url, init) => {
        expect(await new Response(init?.body).text()).toBe(call);
        return Response.json({ jsonrpc: "2.0", id: 7, result: { sessionId: "retained-session" } });
      },
    });
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(z.instanceof(Uint8Array).parse(chunk)));
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined) {
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
        }
        const selected = await handler(
          new Request(downstream, {
            method: "POST",
            headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.writeHead(selected.status, Object.fromEntries(selected.headers));
        response.end(await selected.text());
      })();
    });
    // oxlint-disable-next-line promise/avoid-new -- Adapt the owned listener's readiness event.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = z.object({ port: z.number() }).parse(server.address());
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp/hosted`, {
        method: "POST",
        body: call,
        headers: { authorization: "Bearer controlled-caller-token", connection: "close" },
      });
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { sessionId: "retained-session" },
      });
    } finally {
      // oxlint-disable-next-line promise/avoid-new -- Wait for the owned loopback listener to close.
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });
});
