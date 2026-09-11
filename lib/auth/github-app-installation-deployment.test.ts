import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderConnectionReturn } from "../integrations/provider-connection-return";
import { GitHubInstallationAuthorizationError } from "./github-app-installation";
import { createGitHubAppInstallationRouteHandlers } from "./github-app-installation-deployment";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_one",
  workspaceId: "workspace_one",
};

afterEach(() => vi.restoreAllMocks());

function handlers(
  authorityForRequest: () => Promise<typeof authority | undefined> = async () =>
    authority
) {
  const begin = vi.fn(async () => ({
    action: "github-app.installation.begin" as const,
    authorityDigest: "b".repeat(64),
    expiresAt: "2026-08-28T12:10:00.000Z",
    redirectUrl:
      "https://github.com/apps/autograph-app-builder/installations/new?state=opaque",
    stateDigest: "a".repeat(64),
    status: "redirect" as const,
    version: 1 as const,
  }));
  const complete = vi.fn(async () => ({
    accountType: "Organization" as const,
    action: "github-app.installation.complete" as const,
    appliedAt: "2026-08-28T12:00:00.000Z",
    authorityDigest: "a".repeat(64),
    installationDigest: "c".repeat(64),
    providerUserDigest: "d".repeat(64),
    repositorySelection: "selected" as const,
    returnState: { returnTo: "/" as const } as ProviderConnectionReturn,
    setupAction: "install" as const,
    stateDigest: "b".repeat(64),
    status: "bound" as const,
    version: 1 as const,
  }));
  const route = createGitHubAppInstallationRouteHandlers({
    authorityForRequest,
    authorization: { begin, complete },
    origin: "https://builder.example",
  });
  return { begin, complete, route };
}

describe("GitHub App installation routes", () => {
  it("accepts only a same-origin form POST before leaving Preview", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { route, begin } = handlers();
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: "",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      })
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("github.com/apps/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(begin).toHaveBeenCalledWith(authority, { returnTo: "/" });

    const denied = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: "",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://attacker.example",
        },
        method: "POST",
      })
    );
    expect(denied.headers.get("location")).toBe(
      "https://builder.example/?github=failed&githubReason=request-invalid"
    );
    expect(begin).toHaveBeenCalledOnce();
  });

  it("returns unauthenticated users to sign-in instead of a provider workspace error", async () => {
    const { route } = handlers(async () => {});
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: "",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      })
    );

    expect(response.headers.get("location")).toBe(
      "https://builder.example/auth/sign-in?callbackURL=%2F"
    );
  });

  it("routes onboarding failures to the shared recovery surface", async () => {
    const { route } = handlers(async () => {
      throw new Error("database unavailable");
    });
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: "",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      })
    );
    expect(response.headers.get("location")).toBe(
      "https://builder.example/?onboarding=workspace-setup-retry"
    );
  });

  it("binds the callback only to the current authenticated authority", async () => {
    const { route, complete } = handlers();
    const callback =
      "https://builder.example/github/installations/callback?code=one&installation_id=2&setup_action=install&state=opaque";
    const response = await route.callback(new Request(callback));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://builder.example/?github=connected"
    );
    expect(complete).toHaveBeenCalledWith(callback, authority);
  });

  it("logs a sanitized token-exchange stage without exposing callback data", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { route, complete } = handlers();
    complete.mockRejectedValueOnce(
      new GitHubInstallationAuthorizationError(
        "token-exchange-non-2xx",
        "redirect_uri_mismatch"
      )
    );
    const response = await route.callback(
      new Request(
        "https://builder.example/github/installations/callback?code=secret-code&state=opaque"
      )
    );

    expect(response.headers.get("location")).toBe(
      "https://builder.example/?github=failed&githubReason=callback-invalid"
    );
    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain(
      '"diagnostic":{"stage":"token-exchange-non-2xx","category":"redirect_uri_mismatch"}'
    );
    expect(logged).not.toContain("secret-code");
  });

  it("passes an opaque draft-resume key through a successful callback", async () => {
    const { route, begin, complete } = handlers();
    const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: new URLSearchParams({ returnTo: "/", resumeKey }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      })
    );
    expect(response.status).toBe(303);
    expect(begin).toHaveBeenCalledWith(authority, { resumeKey, returnTo: "/" });
    complete.mockResolvedValueOnce({
      accountType: "Organization" as const,
      action: "github-app.installation.complete" as const,
      appliedAt: "2026-08-28T12:00:00.000Z",
      authorityDigest: "a".repeat(64),
      installationDigest: "c".repeat(64),
      providerUserDigest: "d".repeat(64),
      repositorySelection: "selected" as const,
      returnState: { resumeKey, returnTo: "/" },
      setupAction: "install" as const,
      stateDigest: "b".repeat(64),
      status: "bound" as const,
      version: 1 as const,
    });
    const callback = await route.callback(
      new Request(
        "https://builder.example/github/installations/callback?state=opaque"
      )
    );
    expect(callback.headers.get("location")).toBe(
      `https://builder.example/?github=connected&resume=${resumeKey}`
    );
  });

  it("redirects a connected repository-access continuation back to its parked Eve turn", async () => {
    const complete = vi.fn(async () => ({
      accountType: "Organization" as const,
      action: "github-app.installation.complete" as const,
      appliedAt: "2026-08-28T12:00:00.000Z",
      authorityDigest: "a".repeat(64),
      installationDigest: "c".repeat(64),
      providerUserDigest: "d".repeat(64),
      repositorySelection: "selected" as const,
      returnState: {
        resumeKey: "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0",
        returnTo: "/" as const,
      },
      setupAction: "install" as const,
      stateDigest: "b".repeat(64),
      status: "bound" as const,
      version: 1 as const,
    }));
    const onConnected = vi.fn(
      async () =>
        "https://builder.example/eve/v1/connections/github-repository-access/callback/attempt/token?provider=github&status=connected"
    );
    const route = createGitHubAppInstallationRouteHandlers({
      authorityForRequest: async () => authority,
      authorization: {
        begin: vi.fn(),
        complete,
      } as never,
      onConnected,
      origin: "https://builder.example",
    });
    const response = await route.callback(
      new Request(
        "https://builder.example/github/installations/callback?state=opaque"
      )
    );
    expect(response.headers.get("location")).toContain(
      "/eve/v1/connections/github-repository-access/callback/"
    );
    expect(onConnected).toHaveBeenCalledWith({
      authority,
      returnState: expect.objectContaining({
        resumeKey: "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0",
      }),
    });
  });
});
