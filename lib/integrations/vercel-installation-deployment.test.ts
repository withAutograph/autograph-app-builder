import { describe, expect, it, vi } from "vitest";

import { createVercelInstallationDeploymentHandler } from "./vercel-installation-deployment";

describe("Vercel installation deployment route", () => {
  it("returns a visible configuration failure when provider activation is absent", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handler = createVercelInstallationDeploymentHandler("start", {
      APP_ORIGIN: "https://builder.example",
    });
    const response = await handler(
      new Request("https://builder.example/vercel/installations/start", {
        method: "POST",
        headers: {
          Origin: "https://builder.example",
          "Content-Type": "application/x-www-form-urlencoded",
          "x-vercel-id": "iad1::safe-request-id",
        },
        body: "",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://builder.example/?vercel=failed&vercelReason=configuration-unavailable",
    );
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain(
      '"reason":"configuration-unavailable"',
    );
    expect(error.mock.calls[0]?.[0]).toContain(
      '"requestId":"iad1::safe-request-id"',
    );
  });

  it("rejects a cross-origin start before initializing provider state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createVercelInstallationDeploymentHandler("start", {
      APP_ORIGIN: "https://builder.example",
    });
    const response = await handler(
      new Request("https://builder.example/vercel/installations/start", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      }),
    );

    expect(response.headers.get("location")).toBe(
      "https://builder.example/?vercel=failed&vercelReason=request-invalid",
    );
  });
});
