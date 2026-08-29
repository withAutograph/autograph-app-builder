import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EveSessionService } from "../eve/service";
import {
  attachPrototypePreviewUrl,
  createPrototypePreviewRequestHandler,
  createServicePrototypePreviewResolver,
  prototypePreviewContentSecurityPolicy,
} from "./browser-preview";

const content =
  '<!doctype html><html><body><script>document.body.dataset.ready="yes"</script>Vendor queue</body></html>';
const digest = createHash("sha256").update(content).digest("hex");
const prototype = {
  path: "prototype/vendor-onboarding/index.html",
  mediaType: "text/html" as const,
  content,
  digest,
  revision: "b".repeat(64),
};
const result = {
  sessionId: "session-one",
  status: "completed" as const,
  cursor: 12,
  events: [],
  prototype,
};

describe("Browser prototype preview", () => {
  it("attaches only hosted HTTPS or loopback URLs", () => {
    expect(
      attachPrototypePreviewUrl(result, "https://builder.example.test/mcp")
        .prototype?.previewUrl,
    ).toBe(
      `https://builder.example.test/preview/session-one/${prototype.digest}`,
    );
    expect(
      attachPrototypePreviewUrl(result, "http://127.0.0.1:3000/mcp").prototype
        ?.previewUrl,
    ).toBe(`http://127.0.0.1:3000/preview/session-one/${prototype.digest}`);
    expect(
      attachPrototypePreviewUrl(result, "http://builder.example.test/mcp")
        .prototype?.previewUrl,
    ).toBeUndefined();
  });

  it("serves exact prototype bytes only through an isolated no-store page", async () => {
    const resolvePrototype = vi.fn(async () => prototype);
    const handler = createPrototypePreviewRequestHandler({ resolvePrototype });
    const response = await handler(
      new Request(`https://builder.example.test/preview/session-one/${digest}`),
      { sessionId: "session-one", digest },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      prototypePreviewContentSecurityPolicy,
    );
    expect(prototypePreviewContentSecurityPolicy).toContain(
      "sandbox allow-scripts",
    );
    expect(prototypePreviewContentSecurityPolicy).not.toContain(
      "allow-same-origin",
    );
    expect(prototypePreviewContentSecurityPolicy).toContain(
      "connect-src 'none'",
    );
    expect(prototypePreviewContentSecurityPolicy).toContain(
      "form-action 'none'",
    );
    expect(resolvePrototype).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-one" }),
    );
  });

  it("makes malformed, stale, tampered, and unavailable previews indistinguishable", async () => {
    const cases = [
      {
        route: { sessionId: "../other", digest },
        prototype,
      },
      {
        route: { sessionId: "session-one", digest: "c".repeat(64) },
        prototype,
      },
      {
        route: { sessionId: "session-one", digest },
        prototype: { ...prototype, content: `${content}tampered` },
      },
      {
        route: { sessionId: "session-one", digest },
        prototype: undefined,
      },
    ];
    for (const candidate of cases) {
      const handler = createPrototypePreviewRequestHandler({
        resolvePrototype: async () => candidate.prototype,
      });
      const response = await handler(
        new Request(
          `https://builder.example.test/preview/session-one/${digest}`,
        ),
        candidate.route,
      );
      expect({
        status: response.status,
        body: await response.text(),
      }).toEqual({ status: 404, body: "" });
    }
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
      }),
    ).resolves.toEqual(prototype);
    expect(get).toHaveBeenCalledWith({
      sessionId: "session-one",
      cursor: 0,
      limit: 1,
    });
  });
});
