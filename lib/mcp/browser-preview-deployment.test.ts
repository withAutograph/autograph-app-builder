import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EveSessionService } from "../eve/service";
import { createDeploymentPrototypePreviewRequestHandler } from "./browser-preview-deployment";

const content = "<!doctype html><html><body>Vendor queue</body></html>";
const digest = createHash("sha256").update(content).digest("hex");

describe("deployment Browser preview route", () => {
  it("serves the exact artifact selected by the request-scoped service", async () => {
    const get = vi.fn(async () => ({
      sessionId: "session-one",
      status: "completed" as const,
      cursor: 1,
      events: [],
      prototype: {
        path: "prototype/vendor-onboarding/index.html",
        mediaType: "text/html" as const,
        content,
        digest,
        revision: "b".repeat(64),
      },
    }));
    const serviceForRequest = vi.fn(async () =>
      Promise.resolve({ get } as unknown as EveSessionService),
    );
    const handler = createDeploymentPrototypePreviewRequestHandler({
      environment: {},
      workloadIdentity: {
        async token() {
          throw new Error("Hosted workload identity must not be requested.");
        },
      },
      serviceForRequest,
    });
    const request = new Request(
      `https://builder.example.test/preview/session-one/${digest}`,
    );
    const response = await handler(request, {
      sessionId: "session-one",
      digest,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content);
    expect(serviceForRequest).toHaveBeenCalledWith(request);
    expect(get).toHaveBeenCalledWith({
      sessionId: "session-one",
      cursor: 0,
      limit: 1,
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
      { sessionId: "session-one", digest },
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
