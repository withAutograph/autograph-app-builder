import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitHubAppInstallationRouteHandlers } from "./github-app-installation-deployment";
import type { ProviderConnectionReturn } from "../integrations/provider-connection-return";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace_one",
  ownerUserId: "user_one",
};

afterEach(() => vi.restoreAllMocks());

function handlers(
  authorityForRequest: () => Promise<typeof authority | undefined> = async () =>
    authority,
) {
  const begin = vi.fn(async () => ({
    version: 1 as const,
    action: "github-app.installation.begin" as const,
    status: "redirect" as const,
    redirectUrl:
      "https://github.com/apps/autograph-app-builder/installations/new?state=opaque",
    stateDigest: "a".repeat(64),
    authorityDigest: "b".repeat(64),
    expiresAt: "2026-08-28T12:10:00.000Z",
  }));
  const complete = vi.fn(async () => ({
    version: 1 as const,
    action: "github-app.installation.complete" as const,
    status: "bound" as const,
    authorityDigest: "a".repeat(64),
    stateDigest: "b".repeat(64),
    installationDigest: "c".repeat(64),
    providerUserDigest: "d".repeat(64),
    accountType: "Organization" as const,
    repositorySelection: "selected" as const,
    setupAction: "install" as const,
    returnState: { returnTo: "/" as const } as ProviderConnectionReturn,
    appliedAt: "2026-08-28T12:00:00.000Z",
  }));
  const route = createGitHubAppInstallationRouteHandlers({
    origin: "https://builder.example",
    authorityForRequest,
    authorization: { begin, complete },
  });
  return { route, begin, complete };
}

describe("GitHub App installation routes", () => {
  it("accepts only a same-origin form POST before leaving Preview", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { route, begin } = handlers();
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        method: "POST",
        headers: {
          Origin: "https://builder.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("github.com/apps/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(begin).toHaveBeenCalledWith(authority, { returnTo: "/" });

    const denied = await route.start(
      new Request("https://builder.example/github/installations/start", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      }),
    );
    expect(denied.headers.get("location")).toBe(
      "https://builder.example/?github=failed&githubReason=request-invalid",
    );
    expect(begin).toHaveBeenCalledOnce();
  });

  it("returns an actionable workspace failure without exposing authority data", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { route } = handlers(async () => undefined);
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        method: "POST",
        headers: {
          Origin: "https://builder.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      }),
    );

    expect(response.headers.get("location")).toBe(
      "https://builder.example/?github=failed&githubReason=workspace-unavailable",
    );
    expect(error).toHaveBeenCalledOnce();
    const logged = error.mock.calls[0]?.[0];
    expect(logged).toContain('"reason":"workspace-unavailable"');
    expect(logged).not.toContain(authority.ownerUserId);
    expect(logged).not.toContain(authority.workspaceId);
  });

  it("binds the callback only to the current authenticated authority", async () => {
    const { route, complete } = handlers();
    const callback =
      "https://builder.example/github/installations/callback?code=one&installation_id=2&setup_action=install&state=opaque";
    const response = await route.callback(new Request(callback));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://builder.example/?github=connected",
    );
    expect(complete).toHaveBeenCalledWith(callback, authority);
  });

  it("passes an opaque draft-resume key through a successful callback", async () => {
    const { route, begin, complete } = handlers();
    const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        method: "POST",
        headers: {
          Origin: "https://builder.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ returnTo: "/", resumeKey }),
      }),
    );
    expect(response.status).toBe(303);
    expect(begin).toHaveBeenCalledWith(authority, { returnTo: "/", resumeKey });
    complete.mockResolvedValueOnce({
      version: 1 as const,
      action: "github-app.installation.complete" as const,
      status: "bound" as const,
      authorityDigest: "a".repeat(64),
      stateDigest: "b".repeat(64),
      installationDigest: "c".repeat(64),
      providerUserDigest: "d".repeat(64),
      accountType: "Organization" as const,
      repositorySelection: "selected" as const,
      setupAction: "install" as const,
      appliedAt: "2026-08-28T12:00:00.000Z",
      returnState: { returnTo: "/", resumeKey },
    });
    const callback = await route.callback(
      new Request(
        "https://builder.example/github/installations/callback?state=opaque",
      ),
    );
    expect(callback.headers.get("location")).toBe(
      `https://builder.example/?github=connected&resume=${resumeKey}`,
    );
  });
});
