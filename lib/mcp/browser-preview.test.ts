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
  it("uses the supervisor-owned non-default loopback origin only in exact development mode", () => {
    const developmentRequestUrl = prototypePreviewRequestUrl({
      environment: {
        APP_BUILDER_DEVELOPMENT_ORIGIN: loopbackDevelopmentOrigin(3_100),
        APP_BUILDER_EXECUTION_BUNDLE: "local-development",
        APP_BUILDER_EXECUTION_MODE: "development",
        APP_BUILDER_LOCAL_ADAPTER: "1",
        APP_BUILDER_SANDBOX_PROVIDER: "vercel",
        EVE_HOSTED_ADAPTER: "0",
      },
      requestUrl: "http://localhost:3000/mcp",
    });
    expect(
      attachPrototypePreviewUrl(result, developmentRequestUrl).prototype
    ).toMatchObject({
      previewUrl: `http://127.0.0.1:3100/preview/session-one/${prototype.digest}`,
    });

    expect(
      prototypePreviewRequestUrl({
        environment: {
          APP_BUILDER_DEVELOPMENT_ORIGIN: loopbackDevelopmentOrigin(3_100),
          APP_BUILDER_EXECUTION_BUNDLE: "local-development",
          APP_BUILDER_EXECUTION_MODE: "development",
          APP_BUILDER_LOCAL_ADAPTER: "0",
          APP_BUILDER_SANDBOX_PROVIDER: "vercel",
          EVE_HOSTED_ADAPTER: "1",
        },
        requestUrl: "https://builder.example.test/mcp",
      })
    ).toBe("https://builder.example.test/mcp");
  });

  it("attaches only hosted HTTPS or loopback URLs", () => {
    expect(
      attachPrototypePreviewUrl(result, "https://builder.example.test/mcp")
        .prototype?.previewUrl
    ).toBe(
      `https://builder.example.test/preview/session-one/${prototype.digest}`
    );
    expect(
      attachPrototypePreviewUrl(result, "http://127.0.0.1:3000/mcp").prototype
        ?.previewUrl
    ).toBe(`http://127.0.0.1:3000/preview/session-one/${prototype.digest}`);
    expect(
      attachPrototypePreviewUrl(result, "http://builder.example.test/mcp")
        .prototype?.previewUrl
    ).toBeUndefined();
  });

  it("serves exact prototype bytes only through an isolated no-store page", async () => {
    const resolvePrototype = vi.fn(async () => prototype);
    const handler = createPrototypePreviewRequestHandler({ resolvePrototype });
    const response = await handler(
      new Request(`https://builder.example.test/preview/session-one/${digest}`),
      { digest, sessionId: "session-one" }
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(response.headers.get("content-security-policy")).toBe(
      prototypePreviewContentSecurityPolicy
    );
    // Forms must dispatch their local submit event so generated prototypes can
    // handle it with preventDefault(); CSP still rejects every navigation.
    expect(prototypePreviewContentSecurityPolicy).toContain(
      "sandbox allow-forms allow-scripts"
    );
    expect(prototypePreviewContentSecurityPolicy).not.toContain(
      "allow-same-origin"
    );
    expect(prototypePreviewContentSecurityPolicy).toContain(
      "connect-src 'none'"
    );
    expect(prototypePreviewContentSecurityPolicy).toContain(
      "form-action 'none'"
    );
    expect(resolvePrototype).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-one" })
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
    const projections: Record<string, string | number | null>[] = [];
    for (const candidate of cases) {
      const handler = createPrototypePreviewRequestHandler({
        resolvePrototype: async () => {
          if (candidate.prototype instanceof Error) {
            throw candidate.prototype;
          }
          return candidate.prototype;
        },
      });
      const response = await handler(
        new Request(
          `https://builder.example.test/preview/session-one/${digest}`
        ),
        candidate.route
      );
      projections.push({
        body: await response.text(),
        cache: response.headers.get("cache-control"),
        contentSecurityPolicy: response.headers.get("content-security-policy"),
        contentType: response.headers.get("content-type"),
        contentTypeOptions: response.headers.get("x-content-type-options"),
        crossOriginResourcePolicy: response.headers.get(
          "cross-origin-resource-policy"
        ),
        permissionsPolicy: response.headers.get("permissions-policy"),
        referrerPolicy: response.headers.get("referrer-policy"),
        status: response.status,
      });
    }
    expect(
      new Set(projections.map((projection) => JSON.stringify(projection))).size
    ).toBe(1);
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
    const get = vi.fn(async () => result);
    const service = { get } as unknown as EveSessionService;
    const resolver = createServicePrototypePreviewResolver({
      serviceForRequest: async () => service,
    });
    await expect(
      resolver({
        request: new Request("https://builder.example.test/preview"),
        sessionId: "session-one",
      })
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
      serviceForRequest: async () => ({ get }) as unknown as EveSessionService,
    });
    await expect(
      resolver({
        request: new Request("https://builder.example.test/preview"),
        sessionId: "session-one",
      })
    ).resolves.toEqual(prototype);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
