import { describe, expect, it, vi } from "vitest";

import { createGitHubAppInstallationRouteHandlers } from "./github-app-installation-deployment";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace_one",
  ownerUserId: "user_one",
};

function handlers() {
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
    appliedAt: "2026-08-28T12:00:00.000Z",
  }));
  const route = createGitHubAppInstallationRouteHandlers({
    origin: "https://builder.example",
    authorityForRequest: async () => authority,
    authorization: { begin, complete },
  });
  return { route, begin, complete };
}

describe("GitHub App installation routes", () => {
  it("accepts only a same-origin form POST before leaving Preview", async () => {
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
    expect(begin).toHaveBeenCalledWith(authority);

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
      "https://builder.example/github/installations?status=failed",
    );
    expect(begin).toHaveBeenCalledOnce();
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
});
