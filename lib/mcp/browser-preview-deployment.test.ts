import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EveSessionService } from "../eve/service";
import { createDeploymentPrototypePreviewRequestHandler } from "./browser-preview-deployment";

const content = "<!doctype html><html><body>Vendor queue</body></html>";
const digest = createHash("sha256").update(content).digest("hex");

describe("deployment Browser preview route", () => {
  it("serves the exact artifact selected by the request-scoped service", async () => {
    const get = vi.fn(async () => ({
      cursor: 1,
      events: [],
      prototype: {
        content,
        digest,
        mediaType: "text/html" as const,
        path: "prototype/vendor-onboarding/index.html",
        revision: "b".repeat(64),
      },
      sessionId: "session-one",
      status: "completed" as const,
    }));
    const serviceForRequest = vi.fn(
      async () => ({ get }) as unknown as EveSessionService
    );
    const handler = createDeploymentPrototypePreviewRequestHandler({
      environment: {},
      serviceForRequest,
      workloadIdentity: {
        async token() {
          throw new Error("Hosted workload identity must not be requested.");
        },
      },
    });
    const request = new Request(
      `https://builder.example.test/preview/session-one/${digest}`
    );
    const response = await handler(request, {
      digest,
      sessionId: "session-one",
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content);
    expect(serviceForRequest).toHaveBeenCalledWith(request);
    expect(get).toHaveBeenCalledWith({
      cursor: 0,
      limit: 1,
      sessionId: "session-one",
    });
  });

  it("fails closed when no request-scoped service is available", async () => {
    const handler = createDeploymentPrototypePreviewRequestHandler({
      environment: {},
      workloadIdentity: {
        async token() {
          throw new Error("Hosted workload identity must not be requested.");
        },
      },
    });
    const response = await handler(
      new Request(`https://builder.example.test/preview/session-one/${digest}`),
      { digest, sessionId: "session-one" }
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
