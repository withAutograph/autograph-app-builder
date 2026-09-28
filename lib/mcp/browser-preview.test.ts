import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EveSessionService } from "../eve/service";
import {
  attachPrototypePreviewUrl,
  createPrototypePreviewRequestHandler,
  createServicePrototypePreviewResolver,
  loopbackDevelopmentOrigin,
  prototypePreviewRequestUrl,
  prototypePreviewContentSecurityPolicy,
} from "./browser-preview";

const content =
  '<!doctype html><html><body><script>document.body.dataset.ready="yes"</script>Vendor queue</body></html>';
const digest = createHash("sha256").update(content).digest("hex");
const prototype = {
  content,
  digest,
  mediaType: "text/html" as const,
  path: "prototype/vendor-onboarding/index.html",
  revision: "b".repeat(64),
};
const result = {
  cursor: 12,
  events: [],
  prototype,
  sessionId: "session-one",
  status: "completed" as const,
};

describe("Browser prototype preview", () => {
  it("verifies a v2 manifest before streaming its exact chunks", async () => {
    const path = "prototype/vendor-onboarding/index.html";
    const chunks = [content.slice(0, 19), content.slice(19)];
    const artifact = {
      appId: "vendor-onboarding",
      chunkCount: chunks.length,
      contentBytes: Buffer.byteLength(content),
      digest,
      mediaType: "text/html" as const,
      path,
      recordedByCallId: "call-one",
      revision: createHash("sha256")
        .update(JSON.stringify({ digest, mediaType: "text/html", path }))
        .digest("hex"),
      sessionId: "session-one",
      version: 2 as const,
    };
    expect(
      attachPrototypePreviewUrl(
        {
          cursor: 1,
          events: [],
          prototypeRef: artifact,
          sessionId: "session-one",
          status: "completed",
        },
        "https://builder.example.test/mcp",
      ).prototypeRef?.previewUrl,
    ).toBe(`https://builder.example.test/preview/session-one/${digest}`);
    const readChunk = vi.fn(async (index: number) => await Promise.resolve(chunks[index]));
    const resolveStreamedPrototype = vi.fn(
      async () => await Promise.resolve({ artifact, readChunk }),
    );
    const handler = createPrototypePreviewRequestHandler({
      // oxlint-disable-next-line unicorn/no-useless-undefined, typescript/no-confusing-void-expression -- This v2 test intentionally has no legacy artifact.
      resolvePrototype: async () => await Promise.resolve(undefined),
      resolveStreamedPrototype,
    });
    const response = await handler(
      new Request(`https://builder.example.test/preview/session-one/${digest}`),
      { digest, sessionId: "session-one" },
    );
    expect(response.status).toBe(200);
    expect(readChunk.mock.calls.length).toBeGreaterThanOrEqual(chunks.length);
    await expect(response.text()).resolves.toBe(content);
    expect(readChunk).toHaveBeenCalledTimes(chunks.length * 2);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("content-security-policy")).toBe(
      prototypePreviewContentSecurityPolicy,
    );

    const tampered = createPrototypePreviewRequestHandler({
      // oxlint-disable-next-line unicorn/no-useless-undefined, typescript/no-confusing-void-expression -- This v2 test intentionally has no legacy artifact.
      resolvePrototype: async () => await Promise.resolve(undefined),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double.
      resolveStreamedPrototype: async () => ({
        artifact,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double.
        readChunk: async (index) => (index === 1 ? `${chunks[index]}tampered` : chunks[index]),
      }),
    });
    const denied = await tampered(
      new Request(`https://builder.example.test/preview/session-one/${digest}`),
      { digest, sessionId: "session-one" },
    );
    expect(denied.status).toBe(404);
    await expect(denied.text()).resolves.toBe("");
  });
  it("uses the supervisor-owned non-default loopback origin only in exact development mode", () => {
    const developmentRequestUrl = prototypePreviewRequestUrl({
      environment: {
        APP_BUILDER_DEVELOPMENT_ORIGIN: loopbackDevelopmentOrigin(3100),
        APP_BUILDER_EXECUTION_BUNDLE: "local-development",
        APP_BUILDER_EXECUTION_MODE: "development",
        APP_BUILDER_LOCAL_ADAPTER: "1",
        APP_BUILDER_SANDBOX_PROVIDER: "vercel",
        EVE_HOSTED_ADAPTER: "0",
      },
      requestUrl: "http://localhost:3000/mcp",
    });
    expect(attachPrototypePreviewUrl(result, developmentRequestUrl).prototype).toMatchObject({
      previewUrl: `http://127.0.0.1:3100/preview/session-one/${prototype.digest}`,
    });

    expect(
      prototypePreviewRequestUrl({
        environment: {
          APP_BUILDER_DEVELOPMENT_ORIGIN: loopbackDevelopmentOrigin(3100),
          APP_BUILDER_EXECUTION_BUNDLE: "local-development",
          APP_BUILDER_EXECUTION_MODE: "development",
          APP_BUILDER_LOCAL_ADAPTER: "0",
          APP_BUILDER_SANDBOX_PROVIDER: "vercel",
          EVE_HOSTED_ADAPTER: "1",
        },
        requestUrl: "https://builder.example.test/mcp",
      }),
    ).toBe("https://builder.example.test/mcp");
  });

  it("attaches only hosted HTTPS or loopback URLs", () => {
    expect(
      attachPrototypePreviewUrl(result, "https://builder.example.test/mcp").prototype?.previewUrl,
    ).toBe(`https://builder.example.test/preview/session-one/${prototype.digest}`);
    expect(
      attachPrototypePreviewUrl(result, "http://127.0.0.1:3000/mcp").prototype?.previewUrl,
    ).toBe(`http://127.0.0.1:3000/preview/session-one/${prototype.digest}`);
    expect(
      attachPrototypePreviewUrl(result, "http://builder.example.test/mcp").prototype?.previewUrl,
    ).toBeUndefined();
  });

  it("serves exact prototype bytes only through an isolated no-store page", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const resolvePrototype = vi.fn(async () => prototype);
    const handler = createPrototypePreviewRequestHandler({ resolvePrototype });
    const response = await handler(
      new Request(`https://builder.example.test/preview/session-one/${digest}`),
      { digest, sessionId: "session-one" },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("content-security-policy")).toBe(
      prototypePreviewContentSecurityPolicy,
    );
    // Forms must dispatch their local submit event so generated prototypes can
    // handle it with preventDefault(); CSP still rejects every navigation.
    expect(prototypePreviewContentSecurityPolicy).toContain("sandbox allow-forms allow-scripts");
    expect(prototypePreviewContentSecurityPolicy).not.toContain("allow-same-origin");
    expect(prototypePreviewContentSecurityPolicy).toContain("connect-src 'none'");
    expect(prototypePreviewContentSecurityPolicy).toContain("form-action 'none'");
    expect(resolvePrototype).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-one" }),
    );
  });

  it("makes malformed, stale, tampered, and unavailable previews indistinguishable", async () => {
    const cases = [
      {
        prototype,
        route: { digest, sessionId: "../other" },
      },
      {
        prototype,
        route: { digest: "c".repeat(64), sessionId: "session-one" },
      },
      {
        prototype: { ...prototype, content: `${content}tampered` },
        route: { digest, sessionId: "session-one" },
      },
      {
        prototype: undefined,
        route: { digest, sessionId: "session-one" },
      },
      {
        prototype: new Error("private resolver failure"),
        route: { digest, sessionId: "session-one" },
      },
    ];
    const projections = await Promise.all(
      cases.map(async (candidate) => {
        const handler = createPrototypePreviewRequestHandler({
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
          resolvePrototype: async () => {
            if (candidate.prototype instanceof Error) {
              throw candidate.prototype;
            }
            return candidate.prototype;
          },
        });
        const response = await handler(
          new Request(`https://builder.example.test/preview/session-one/${digest}`),
          candidate.route,
        );
        return {
          body: await response.text(),
          cache: response.headers.get("cache-control"),
          contentSecurityPolicy: response.headers.get("content-security-policy"),
          contentType: response.headers.get("content-type"),
          contentTypeOptions: response.headers.get("x-content-type-options"),
          crossOriginResourcePolicy: response.headers.get("cross-origin-resource-policy"),
          permissionsPolicy: response.headers.get("permissions-policy"),
          referrerPolicy: response.headers.get("referrer-policy"),
          status: response.status,
        };
      }),
    );
    expect(new Set(projections.map((projection) => JSON.stringify(projection))).size).toBe(1);
    expect(projections[0]).toEqual({
      body: "",
      cache: "private, no-store, max-age=0",
      contentSecurityPolicy: prototypePreviewContentSecurityPolicy,
      contentType: "text/html; charset=utf-8",
      contentTypeOptions: "nosniff",
      crossOriginResourcePolicy: "same-origin",
      permissionsPolicy:
        "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
      referrerPolicy: "no-referrer",
      status: 404,
    });
  });

  it("reads the requested owned session through the selected service", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const get = vi.fn(async () => result);
    const service = { get } as unknown as EveSessionService;
    const resolver = createServicePrototypePreviewResolver({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
      serviceForRequest: async () => service,
    });
    await expect(
      resolver({
        request: new Request("https://builder.example.test/preview"),
        sessionId: "session-one",
      }),
    ).resolves.toEqual(prototype);
    expect(get).toHaveBeenCalledWith({
      cursor: 0,
      limit: 1,
      sessionId: "session-one",
    });
  });

  it("waits briefly for a prototype event that is still being delivered", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ ...result, prototype: undefined })
      .mockResolvedValueOnce(result);
    const resolver = createServicePrototypePreviewResolver({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
      serviceForRequest: async () => ({ get }) as unknown as EveSessionService,
    });
    await expect(
      resolver({
        request: new Request("https://builder.example.test/preview"),
        sessionId: "session-one",
      }),
    ).resolves.toEqual(prototype);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

it("keeps explicit HTTPS development previews on localhost", () => {
  const environment = {
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_HOSTED_ADAPTER: "0",
  };
  expect(
    prototypePreviewRequestUrl({
      environment: { ...environment, APP_BUILDER_DEVELOPMENT_ORIGIN: "https://localhost:3100" },
      requestUrl: "http://127.0.0.1:3100/mcp",
    }),
  ).toBe("https://localhost:3100/mcp");
  expect(() =>
    prototypePreviewRequestUrl({
      environment: { ...environment, APP_BUILDER_DEVELOPMENT_ORIGIN: "https://example.test:3100" },
      requestUrl: "http://127.0.0.1:3100/mcp",
    }),
  ).toThrow();
});
