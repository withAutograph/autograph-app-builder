import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HandoffContent } from "../(product)/handoff/[id]/handoff-content";

import type { getBuilderHandoffPageData } from "../../lib/handoff/deployment";

const id = "123e4567-e89b-42d3-a456-426614174001";
const params = Promise.resolve({ id });

const dependencies = () => {
  let loaded: Awaited<ReturnType<typeof getBuilderHandoffPageData>> | undefined;
  let loadError: Error | undefined;
  let requested: Parameters<typeof getBuilderHandoffPageData>[0] | undefined;
  let redirectedTo: string | undefined;
  const load: typeof getBuilderHandoffPageData = async (request) => {
    await Promise.resolve();
    requested = request;
    if (loadError !== undefined) {
      throw loadError;
    }
    return loaded ?? null;
  };
  const redirect = (url: string): never => {
    redirectedTo = url;
    throw new Error(`redirect:${url}`);
  };
  return {
    headers: async () => {
      await Promise.resolve();
      return new Headers({ cookie: "web-session" });
    },
    load,
    redirect,
    get redirectedTo() {
      return redirectedTo;
    },
    get requested() {
      return requested;
    },
    setData(value: Awaited<ReturnType<typeof getBuilderHandoffPageData>>) {
      loaded = value;
    },
    setError(error: Error) {
      loadError = error;
    },
  };
};

describe("authenticated handoff page", () => {
  it("redirects a missing web session back through the same handoff", async () => {
    const services = dependencies();
    const handoffPath = `/handoff/${id}`;
    services.setData(null);
    await expect(HandoffContent({ dependencies: services, params })).rejects.toThrow("redirect:");
    expect(services.redirectedTo).toBe(
      `/auth/sign-in?callbackURL=${encodeURIComponent(handoffPath)}`,
    );
    expect(services.requested?.headers.get("cookie")).toBe("web-session");
  });
  it("does not expose server errors or owner information for an unavailable handoff", async () => {
    const services = dependencies();
    services.setError(new Error("private-owner@example.com database error"));
    const html = renderToStaticMarkup(await HandoffContent({ dependencies: services, params }));
    expect(html).toContain("Handoff unavailable");
    expect(html).not.toContain("private-owner");
    expect(html).not.toContain("database error");
  });
  it("shows that GitHub storage was turned off for a private run", async () => {
    const services = dependencies();
    services.setData({
      handoffId: id,
      intent: {
        appName: "Unit Converter",
        brief: "Convert temperatures",
        connections: [],
        provisioning: {
          github: { code: "not_selected", status: "skipped" },
        },
        repository: { private: true, requestedName: "unit-converter" },
      },
    });
    const html = renderToStaticMarkup(await HandoffContent({ dependencies: services, params }));
    expect(html).toContain("GitHub storage was turned off.");
    expect(html).not.toContain("unit-converter (Private)");
    expect(html).toContain("Continue controls");
  });
  it.each(["credential_unavailable", "provider_unavailable"])(
    "renders saved context and only offers reconnect for credential failures: %s",
    async (code) => {
      const services = dependencies();
      const handoffPath = `/handoff/${id}`;
      services.setData({
        cursorInstallReady: false,
        destination: "cursor",
        expiresAt: "2030-01-01T00:00:00Z",
        handoffId: id,
        intent: {
          appName: "Support App",
          brief: "Help customers",
          connections: ["QuickBooks"],
          provisioning: {
            github: { code, status: "failed" },
            vercel: { code, status: "failed" },
          },
          repository: { private: true, requestedName: "support-app" },
        },
        mcpUrl: "https://builder.example/mcp",
        status: "prepared",
        version: 1,
      });
      const html = renderToStaticMarkup(await HandoffContent({ dependencies: services, params }));
      expect(html).toContain("Support App");
      expect(html).toContain("Help customers");
      expect(html).toContain("QuickBooks");
      if (code === "credential_unavailable") {
        const githubReturnTo = encodeURIComponent(handoffPath);
        const vercelReturnTo = encodeURIComponent(handoffPath);
        expect(html).toContain(`/github/installations?returnTo=${githubReturnTo}`);
        expect(html).toContain(`/vercel/installations?returnTo=${vercelReturnTo}`);
      } else {
        expect(html).not.toContain("Reconnect");
      }
    },
  );
});
