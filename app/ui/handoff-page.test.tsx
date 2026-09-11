import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  load: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock("../../lib/handoff/deployment", () => ({
  getBuilderHandoffPageData: server.load,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "web-session" }),
}));
vi.mock("next/navigation", () => ({ redirect: server.redirect }));
vi.mock("./handoff-controls", () => ({
  HandoffControls: () => <div>Continue controls</div>,
}));
vi.mock("./builder-shell", () => ({
  Header: () => <header>Autograph</header>,
}));

import { HandoffContent } from "../handoff/[id]/handoff-content";

const id = "123e4567-e89b-42d3-a456-426614174001";
const params = Promise.resolve({ id });
afterEach(() => vi.clearAllMocks());

describe("authenticated handoff page", () => {
  it("redirects a missing web session back through the same handoff", async () => {
    server.load.mockResolvedValue(undefined);
    await expect(HandoffContent({ params })).rejects.toThrow("redirect:");
    expect(server.redirect).toHaveBeenCalledWith(
      `/auth/sign-in?callbackURL=${encodeURIComponent(`/handoff/${id}`)}`
    );
    expect(server.load.mock.calls[0]?.[0].headers.get("cookie")).toBe(
      "web-session"
    );
  });
  it("does not expose server errors or owner information for an unavailable handoff", async () => {
    server.load.mockRejectedValue(
      new Error("private-owner@example.com database error")
    );
    const html = renderToStaticMarkup(await HandoffContent({ params }));
    expect(html).toContain("Handoff unavailable");
    expect(html).not.toContain("private-owner");
    expect(html).not.toContain("database error");
  });
  it.each(["credential_unavailable", "provider_unavailable"])(
    "renders saved context and only offers reconnect for credential failures: %s",
    async (code) => {
      server.load.mockResolvedValue({
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
      const html = renderToStaticMarkup(await HandoffContent({ params }));
      expect(html).toContain("Support App");
      expect(html).toContain("Help customers");
      expect(html).toContain("QuickBooks");
      if (code === "credential_unavailable") {
        expect(html).toContain(
          `/github/installations?returnTo=${encodeURIComponent(`/handoff/${id}`)}`
        );
        expect(html).toContain(
          `/vercel/installations?returnTo=${encodeURIComponent(`/handoff/${id}`)}`
        );
      } else {
        expect(html).not.toContain("Reconnect");
      }
    }
  );
});
