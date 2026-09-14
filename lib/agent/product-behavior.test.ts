import http from "node:http";
import { describe, expect, it } from "vitest";
import { executeProductReadback } from "./product-behavior";

const run = async (mode: "stored" | "fake" | "wrong" | "redirect" | "invalid", expired = false) => {
  let stored: unknown;
  const requests: { path: string; cookie?: string; body: string }[] = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ body, cookie: request.headers.cookie, path: request.url ?? "" });
    if (request.url?.startsWith("/__autograph_preview_launch")) {
      response.writeHead(303, { location: "/", "set-cookie": "preview=private; HttpOnly; Path=/" });
    } else if (request.method === "POST") {
      if (mode === "redirect") {
        response.writeHead(307, { location: "https://outside.test/leak" });
      } else {
        if (mode === "stored") {
          stored = JSON.parse(body).value;
        }
        response.writeHead(200, { "content-type": "application/json" });
      }
    } else {
      response.writeHead(200, { "content-type": "application/json" });
    }
    if (mode === "invalid" && request.method === "GET" && request.url === "/record") {
      response.end("<html>Not JSON</html>");
      return;
    }
    response.end(
      JSON.stringify(
        request.method === "POST"
          ? { saved: true }
          : { value: mode === "wrong" ? "wrong" : stored },
      ),
    );
  });
  // oxlint-disable-next-line promise/avoid-new -- Adapt Node server listen callback.
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing server address");
  }
  const transport: typeof fetch = (url, options) => {
    const target = new URL(String(url));
    expect(target.origin).toBe("https://preview.test");
    expect(options?.redirect).toBe("manual");
    expect(options?.credentials).toBe("omit");
    return fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, options);
  };
  try {
    const result = await executeProductReadback({
      authority: {
        expiresAt: Date.now() + (expired ? -1 : 60_000),
        launchUrl: "https://preview.test/__autograph_preview_launch?token=private",
      },
      fetch: transport,
      scenario: {
        body: {},
        markerField: "value",
        outcomeId: "draft-save",
        readPath: "/record",
        readPointer: "/value",
        writePath: "/record",
      },
    });
    return { requests, result };
  } finally {
    server.closeAllConnections();
    // oxlint-disable-next-line promise/avoid-new -- Adapt Node server close callback.
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
};

describe("independent product action/readback", () => {
  it.each(["fake", "wrong", "invalid"] as const)(
    "fails %s success without stored marker",
    async (mode) => {
      const { result } = await run(mode);
      expect(result.status).toBe("failed");
    },
  );
  it("reads actual stored value without sending marker in read", async () => {
    const { requests, result } = await run("stored");
    expect(result.status).toBe("passed");
    expect(result.coverage).toBe("action-readback-only");
    expect(result.unassessed).toContain("restart-durability");
    expect(requests[2]).toEqual({ body: "", cookie: "preview=private", path: "/record" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not follow redirects carrying the preview cookie", async () => {
    const { requests, result } = await run("redirect");
    expect(result.status).toBe("failed");
    expect(requests).toHaveLength(2);
  });
  it("makes no requests for expired authority", async () => {
    const { requests, result } = await run("stored", true);
    expect(result.status).toBe("blocked");
    expect(requests).toHaveLength(0);
  });
});

it("blocks cross-origin paths before transport receives a capability", async () => {
  let called = false;
  const result = await executeProductReadback({
    authority: {
      expiresAt: Date.now() + 60_000,
      launchUrl: "https://preview.test/__autograph_preview_launch?token=private",
    },
    fetch: () => {
      called = true;
      return Promise.reject(new Error("Must not run"));
    },
    scenario: {
      body: {},
      markerField: "value",
      outcomeId: "save",
      readPath: "//outside.test/record",
      readPointer: "/value",
      writePath: "/record",
    },
  });
  expect(called).toBe(false);
  expect(result.status).toBe("blocked");
});

it("honors cancellation before access exchange", async () => {
  let called = false;
  const result = await executeProductReadback({
    authority: {
      expiresAt: Date.now() + 60_000,
      launchUrl: "https://preview.test/__autograph_preview_launch?token=private",
    },
    fetch: () => {
      called = true;
      return Promise.reject(new Error("Must not run"));
    },
    scenario: {
      body: {},
      markerField: "value",
      outcomeId: "save",
      readPath: "/record",
      readPointer: "/value",
      writePath: "/record",
    },
    signal: AbortSignal.abort(),
  });
  expect(called).toBe(false);
  expect(result.reason).toContain("aborted");
});

it("bounds untrusted read response and omits its contents", async () => {
  let count = 0;
  const result = await executeProductReadback({
    authority: {
      expiresAt: Date.now() + 60_000,
      launchUrl: "https://preview.test/__autograph_preview_launch?token=private",
    },
    fetch: () => {
      count += 1;
      if (count === 1) {
        return Promise.resolve(
          new Response(null, {
            headers: { location: "/", "set-cookie": "preview=secret" },
            status: 303,
          }),
        );
      }
      return Promise.resolve(new Response(count === 2 ? "ok" : "sensitive".repeat(10_000)));
    },
    scenario: {
      body: {},
      markerField: "value",
      outcomeId: "save",
      readPath: "/record",
      readPointer: "/value",
      writePath: "/record",
    },
  });
  expect(result.status).toBe("failed");
  expect(JSON.stringify(result)).not.toContain("sensitive");
});
