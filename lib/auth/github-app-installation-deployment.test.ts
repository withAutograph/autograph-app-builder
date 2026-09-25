import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitHubAppInstallationRouteHandlers } from "./github-app-installation-deployment";
import { GitHubInstallationAuthorizationError } from "./github-app-installation";
import type { ProviderConnectionReturn } from "../integrations/provider-connection-return";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_one",
  workspaceId: "workspace_one",
};
const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";
const target = {
  repository: {
    fullName: "withAutograph/arrusted-development",
    name: "arrusted-development",
    owner: "withAutograph",
  },
};
const readyAccess = {
  accessDigest: "a".repeat(64),
  repository: {
    archived: false as const,
    defaultBranch: "main",
    headSha: "b".repeat(40),
    headTree: "c".repeat(40),
    name: target.repository.name,
    owner: target.repository.owner,
    repositoryId: "42",
    repositoryVariableNames: [],
    visibility: "private" as const,
  },
  scope: {
    accountLogin: "withAutograph",
    accountType: "Organization" as const,
    installationId: "98765",
  },
  status: "ready" as const,
};

afterEach(() => vi.restoreAllMocks());

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function handlers(
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  authorityForRequest: () => Promise<typeof authority | undefined> = async () => authority,
  repositoryAccess?: Parameters<
    typeof createGitHubAppInstallationRouteHandlers
  >[0]["repositoryAccess"],
) {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const begin = vi.fn(async () => ({
    action: "github-app.installation.begin" as const,
    authorityDigest: "b".repeat(64),
    expiresAt: "2026-08-28T12:10:00.000Z",
    redirectUrl: "https://github.com/apps/autograph-app-builder/installations/new?state=opaque",
    stateDigest: "a".repeat(64),
    status: "redirect" as const,
    version: 1 as const,
  }));
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const beginExisting = vi.fn(async () => ({
    action: "github-app.installation.authorize" as const,
    authorityDigest: "b".repeat(64),
    expiresAt: "2026-08-28T12:10:00.000Z",
    redirectUrl: "https://github.com/login/oauth/authorize?state=opaque",
    stateDigest: "a".repeat(64),
    status: "redirect" as const,
    version: 1 as const,
  }));
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const complete = vi.fn(async (_inputUrl: string, _authority: typeof authority) => ({
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
    via: "installation" as "installation" | "existing",
  }));
  const routeInput: Parameters<typeof createGitHubAppInstallationRouteHandlers>[0] = {
    authorityForRequest,
    authorization: { begin, beginExisting, complete },
    origin: "https://builder.example",
  };
  if (repositoryAccess !== undefined) {
    routeInput.repositoryAccess = repositoryAccess;
  }
  const route = createGitHubAppInstallationRouteHandlers(routeInput);
  return { begin, beginExisting, complete, route };
}

describe("GitHub App installation routes", () => {
  it("resumes a verified repository without another GitHub authorization", async () => {
    const repositoryAccess = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      authorize: vi.fn(async () => "https://builder.example/eve/v1/connections/callback"),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      classify: vi.fn(async () => readyAccess),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      inspect: vi.fn(async () => target),
    };
    const { route, begin, beginExisting } = handlers(undefined, repositoryAccess);
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: new URLSearchParams({ resumeKey, returnTo: "/" }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );
    expect(response.headers.get("location")).toBe(
      "https://builder.example/eve/v1/connections/callback",
    );
    expect(repositoryAccess.classify).toHaveBeenCalledWith({
      authority,
      repository: target.repository.fullName,
    });
    expect(begin).not.toHaveBeenCalled();
    expect(beginExisting).not.toHaveBeenCalled();
  });

  it("discovers an existing installation, then requests missing repository access", async () => {
    const repositoryAccess = {
      authorize: vi
        .fn<() => Promise<string | undefined>>()
        .mockRejectedValue(new Error("authorization was not expected")),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      classify: vi
        .fn()
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        .mockImplementationOnce(async () => ({
          action: "update" as const,
          repository: target.repository,
          scopes: [],
          status: "authorization-required" as const,
        }))
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        .mockImplementationOnce(async () => ({
          action: "update" as const,
          repository: target.repository,
          scopes: [readyAccess.scope],
          status: "authorization-required" as const,
        })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      inspect: vi.fn(async () => target),
    };
    const { route, begin, beginExisting, complete } = handlers(undefined, repositoryAccess);
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: new URLSearchParams({ resumeKey, returnTo: "/" }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );
    expect(response.headers.get("location")).toContain("github.com/login/oauth/authorize");
    expect(beginExisting).toHaveBeenCalledWith(
      authority,
      { resumeKey, returnTo: "/" },
      { accountLogin: "withAutograph" },
    );
    complete.mockResolvedValueOnce({
      ...(await complete("https://builder.example/github/installations/callback", authority)),
      returnState: { resumeKey, returnTo: "/" },
      via: "existing" as const,
    });
    const callback = await route.callback(
      new Request("https://builder.example/github/installations/callback?code=one&state=opaque"),
    );
    expect(callback.headers.get("location")).toBe(
      "https://github.com/organizations/withAutograph/settings/installations/98765",
    );
    expect(begin).not.toHaveBeenCalled();
    expect(repositoryAccess.authorize).not.toHaveBeenCalled();
  });

  it("opens the verified installation settings when it already lacks the repository", async () => {
    const repositoryAccess = {
      authorize: vi
        .fn<() => Promise<string | undefined>>()
        .mockRejectedValue(new Error("authorization was not expected")),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      classify: vi.fn(async () => ({
        action: "update" as const,
        repository: target.repository,
        scopes: [readyAccess.scope],
        status: "authorization-required" as const,
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      inspect: vi.fn(async () => target),
    };
    const { route, begin, beginExisting } = handlers(undefined, repositoryAccess);
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: new URLSearchParams({ resumeKey, returnTo: "/" }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );
    expect(response.headers.get("location")).toBe(
      "https://github.com/organizations/withAutograph/settings/installations/98765",
    );
    expect(begin).not.toHaveBeenCalled();
    expect(beginExisting).not.toHaveBeenCalled();
    expect(repositoryAccess.authorize).not.toHaveBeenCalled();
  });

  it("reports a missing repository after installation setup instead of claiming success", async () => {
    const repositoryAccess = {
      authorize: vi
        .fn<() => Promise<string | undefined>>()
        .mockRejectedValue(new Error("authorization was not expected")),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      classify: vi.fn(async () => ({
        action: "update" as const,
        repository: target.repository,
        scopes: [],
        status: "authorization-required" as const,
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      inspect: vi.fn(async () => target),
    };
    const { route, begin, complete } = handlers(undefined, repositoryAccess);
    complete.mockResolvedValueOnce({
      ...(await complete("https://builder.example/github/installations/callback", authority)),
      returnState: { resumeKey, returnTo: "/" },
      via: "installation" as const,
    });
    const response = await route.callback(
      new Request("https://builder.example/github/installations/callback?code=one&state=opaque"),
    );
    expect(response.headers.get("location")).toBe(
      `https://builder.example/?github=failed&githubReason=repository-access-missing&resume=${resumeKey}`,
    );
    expect(begin).not.toHaveBeenCalled();
    expect(repositoryAccess.authorize).not.toHaveBeenCalled();
  });

  it("rejects an expired repository continuation before contacting GitHub", async () => {
    const repositoryAccess = {
      authorize: vi
        .fn<() => Promise<string | undefined>>()
        .mockRejectedValue(new Error("authorization was not expected")),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      classify: vi.fn(async () => readyAccess),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      hasBuilderDraft: vi.fn(async () => false),
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Model an expired continuation.
      inspect: vi.fn<() => Promise<typeof target | undefined>>().mockResolvedValue(undefined),
    };
    const { route, begin, beginExisting } = handlers(undefined, repositoryAccess);
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: new URLSearchParams({ resumeKey, returnTo: "/" }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );
    expect(response.headers.get("location")).toBe(
      `https://builder.example/?github=failed&githubReason=authorization-expired&resume=${resumeKey}`,
    );
    expect(begin).not.toHaveBeenCalled();
    expect(beginExisting).not.toHaveBeenCalled();
    expect(repositoryAccess.hasBuilderDraft).toHaveBeenCalledWith({
      authority,
      draftId: resumeKey,
    });
  });

  it("keeps a tenant-authorized Builder draft on the ordinary GitHub connection path", async () => {
    const repositoryAccess = {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Model no repository continuation callback.
      authorize: vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      classify: vi.fn(async () => readyAccess),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      hasBuilderDraft: vi.fn(async () => true),
      // oxlint-disable-next-line unicorn/no-useless-undefined -- No repository continuation exists for a Builder draft.
      inspect: vi.fn<() => Promise<typeof target | undefined>>().mockResolvedValue(undefined),
    };
    const { route, beginExisting } = handlers(undefined, repositoryAccess);
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: new URLSearchParams({ resumeKey, returnTo: "/" }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );
    expect(response.headers.get("location")).toContain("github.com/login/oauth/authorize");
    expect(repositoryAccess.hasBuilderDraft).toHaveBeenCalledWith({
      authority,
      draftId: resumeKey,
    });
    expect(repositoryAccess.classify).not.toHaveBeenCalled();
    expect(beginExisting).toHaveBeenCalledWith(authority, { resumeKey, returnTo: "/" }, undefined);
  });
  it("accepts only a same-origin form POST before leaving Preview", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { route, begin, beginExisting } = handlers();
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: "",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("github.com/login/oauth/authorize");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(beginExisting).toHaveBeenCalledWith(authority, { returnTo: "/" }, undefined);
    expect(begin).not.toHaveBeenCalled();

    const denied = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: "",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://attacker.example",
        },
        method: "POST",
      }),
    );
    expect(denied.headers.get("location")).toBe(
      "https://builder.example/?github=failed&githubReason=request-invalid",
    );
    expect(beginExisting).toHaveBeenCalledOnce();
  });

  it("starts direct authorization for an existing installation without changing GitHub access", async () => {
    const { route, begin, beginExisting } = handlers();
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: new URLSearchParams({ connectionMode: "existing", resumeKey, returnTo: "/" }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );
    expect(response.headers.get("location")).toContain("github.com/login/oauth/authorize");
    expect(beginExisting).toHaveBeenCalledWith(authority, { resumeKey, returnTo: "/" }, undefined);
    expect(begin).not.toHaveBeenCalled();
  });

  it("returns unauthenticated users to sign-in instead of a provider workspace error", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const { route } = handlers(async () => {});
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: "",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );

    expect(response.headers.get("location")).toBe(
      "https://builder.example/auth/sign-in?callbackURL=%2F",
    );
  });

  it("routes onboarding failures to the shared recovery surface", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
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
      }),
    );
    expect(response.headers.get("location")).toBe(
      "https://builder.example/?onboarding=workspace-setup-retry",
    );
  });

  it("binds the callback only to the current authenticated authority", async () => {
    const { route, complete } = handlers();
    const callback =
      "https://builder.example/github/installations/callback?code=one&installation_id=2&setup_action=install&state=opaque";
    const response = await route.callback(new Request(callback));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://builder.example/?github=connected");
    expect(complete).toHaveBeenCalledWith(callback, authority);
  });

  it("logs a sanitized token-exchange stage without exposing callback data", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { route, complete } = handlers();
    complete.mockRejectedValueOnce(
      new GitHubInstallationAuthorizationError("token-exchange-non-2xx", "redirect_uri_mismatch"),
    );
    const response = await route.callback(
      new Request(
        "https://builder.example/github/installations/callback?code=secret-code&state=opaque",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://builder.example/?github=failed&githubReason=callback-invalid",
    );
    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain(
      '"diagnostic":{"stage":"token-exchange-non-2xx","category":"redirect_uri_mismatch"}',
    );
    expect(logged).not.toContain("secret-code");
  });

  it("reports a denied GitHub authorization without claiming a connection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { route, complete } = handlers();
    complete.mockRejectedValueOnce(
      new GitHubInstallationAuthorizationError("oauth-callback-error", "access_denied"),
    );
    const response = await route.callback(
      new Request(
        "https://builder.example/github/installations/callback?error=access_denied&state=opaque",
      ),
    );
    expect(response.headers.get("location")).toBe(
      "https://builder.example/?github=failed&githubReason=access-denied",
    );
  });

  it("explains when the GitHub user cannot access the selected installation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { route, complete } = handlers();
    complete.mockRejectedValueOnce(
      new GitHubInstallationAuthorizationError(
        "installation-identity-validation",
        undefined,
        undefined,
        undefined,
        undefined,
        "requested-installation-unavailable",
      ),
    );
    const response = await route.callback(
      new Request("https://builder.example/github/installations/callback?code=one&state=opaque"),
    );
    expect(response.headers.get("location")).toBe(
      "https://builder.example/?github=failed&githubReason=installation-not-accessible",
    );
  });

  it("passes an opaque draft-resume key through a successful callback", async () => {
    const { route, beginExisting, complete } = handlers();
    const response = await route.start(
      new Request("https://builder.example/github/installations/start", {
        body: new URLSearchParams({ resumeKey, returnTo: "/" }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://builder.example",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(303);
    expect(beginExisting).toHaveBeenCalledWith(authority, { resumeKey, returnTo: "/" }, undefined);
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
      via: "installation" as const,
    });
    const callback = await route.callback(
      new Request("https://builder.example/github/installations/callback?state=opaque"),
    );
    expect(callback.headers.get("location")).toBe(
      `https://builder.example/?github=connected&resume=${resumeKey}`,
    );
  });

  it("redirects a connected repository-access continuation back to its parked Eve turn", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
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
      via: "installation" as const,
    }));
    const onConnected = vi.fn(
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async () =>
        "https://builder.example/eve/v1/connections/github-repository-access/callback/attempt/token?provider=github&status=connected",
    );
    const route = createGitHubAppInstallationRouteHandlers({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      authorityForRequest: async () => authority,
      authorization: {
        begin: vi.fn(),
        complete,
      } as never,
      onConnected,
      origin: "https://builder.example",
    });
    const response = await route.callback(
      new Request("https://builder.example/github/installations/callback?state=opaque"),
    );
    expect(response.headers.get("location")).toContain(
      "/eve/v1/connections/github-repository-access/callback/",
    );
    expect(onConnected).toHaveBeenCalledWith({
      authority,
      returnState: expect.objectContaining({
        resumeKey: "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0",
      }),
    });
  });
});
