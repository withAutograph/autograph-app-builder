import { describe, expect, it, vi } from "vitest";

import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  createGitHubAppInstallationAuthorization,
  githubInstallationAuthorizationDiagnostic,
  readGitHubAppInstallationEnvironment,
  type GitHubInstallationAuthorizationStateStore,
} from "./github-app-installation";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace_one",
  ownerUserId: "user_one",
};

const config = {
  appId: "12345",
  appSlug: "autograph-app-builder",
  clientId: "Iv1_app_client",
  clientSecret: "client-secret-sentinel-value",
  stateSecret: "state-secret-sentinel-value-with-32-characters",
  issuer: authority.issuer,
  resource: authority.audience,
};

function harness(input?: { membership?: () => boolean; fetch?: typeof fetch }) {
  const states = new Map<
    string,
    { consumed: boolean; authorityDigest: string }
  >();
  const events: string[] = [];
  const stateStore: GitHubInstallationAuthorizationStateStore = {
    async create(value) {
      events.push("state:create");
      states.set(value.stateDigest, {
        consumed: false,
        authorityDigest: value.authorityDigest,
      });
    },
    async consume(value) {
      events.push("state:consume");
      const state = states.get(value.stateDigest);
      if (
        state === undefined ||
        state.consumed ||
        state.authorityDigest !== value.authorityDigest
      ) {
        return false;
      }
      state.consumed = true;
      return true;
    },
  };
  const bind = vi.fn<HostedGitHubInstallationStore["bind"]>(async (value) => {
    events.push("installation:bind");
    return { ...value.binding, active: true, updatedAt: value.now };
  });
  const installationStore: HostedGitHubInstallationStore = {
    async read() {
      return undefined;
    },
    bind,
  };
  const membership = vi.fn(async () => {
    events.push("membership");
    return input?.membership?.() ?? true;
  });
  const authorization = createGitHubAppInstallationAuthorization({
    config,
    stateStore,
    membership: { isActiveMember: membership },
    installationStore,
    fetch: input?.fetch,
    now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    nonce: () => "n".repeat(43),
  });
  return { authorization, bind, events, membership };
}

function setupCallbackUrl(
  state: string,
  setupAction: "install" | "update" = "install",
) {
  const url = new URL("https://builder.example/github/installations/callback");
  url.searchParams.set("installation_id", "98765");
  url.searchParams.set("setup_action", setupAction);
  url.searchParams.set("state", state);
  return url.toString();
}

function authorizationCallbackUrl(state: string) {
  const url = new URL("https://builder.example/github/installations/callback");
  url.searchParams.set("code", "one-time-code");
  url.searchParams.set("state", state);
  return url.toString();
}

async function prepareAuthorization(
  authorization: ReturnType<typeof createGitHubAppInstallationAuthorization>,
) {
  const begun = await authorization.begin(authority);
  const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
  const authorize = await authorization.complete(
    setupCallbackUrl(installState),
    authority,
  );
  if (authorize.status !== "redirect") throw new Error("expected redirect");
  const authorizeUrl = new URL(authorize.redirectUrl);
  expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(
    /^[A-Za-z0-9_-]{43}$/u,
  );
  return {
    begun,
    installState,
    authorizeState: authorizeUrl.searchParams.get("state")!,
  };
}

function successfulFetch(
  seen: Array<{ url: string; init?: RequestInit }>,
  repositorySelection: "all" | "selected" = "selected",
) {
  return vi.fn<typeof fetch>(async (resource, init) => {
    const url = String(resource);
    seen.push({ url, init });
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "github-user-token-sentinel-value",
        token_type: "bearer",
        scope: "",
      });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: 321, login: "installer" });
    }
    if (
      url === "https://api.github.com/user/installations?per_page=100&page=1"
    ) {
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 98765,
            app_id: 12345,
            app_slug: "autograph-app-builder",
            target_type: "Organization",
            repository_selection: repositorySelection,
            suspended_at: null,
            account: {
              id: 149546148,
              login: "withAutograph",
              type: "Organization",
            },
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe("public GitHub App installation authorization", () => {
  it("reads one exact Preview-only environment contract", () => {
    expect(
      readGitHubAppInstallationEnvironment({
        GITHUB_APP_ID: config.appId,
        GITHUB_APP_SLUG: config.appSlug,
        GITHUB_APP_CLIENT_ID: config.clientId,
        GITHUB_APP_CLIENT_SECRET: config.clientSecret,
        GITHUB_APP_INSTALL_STATE_SECRET: config.stateSecret,
        BETTER_AUTH_URL: config.issuer,
        MCP_RESOURCE_URL: config.resource,
      }),
    ).toEqual(config);
    expect(() =>
      readGitHubAppInstallationEnvironment({
        GITHUB_APP_ID: config.appId,
        GITHUB_APP_SLUG: config.appSlug,
        GITHUB_APP_CLIENT_ID: config.clientId,
        GITHUB_APP_CLIENT_SECRET: config.clientSecret,
        GITHUB_APP_INSTALL_STATE_SECRET: config.stateSecret,
        BETTER_AUTH_URL: config.issuer,
        MCP_RESOURCE_URL: config.resource,
        GITHUB_TOKEN: "ambient-token",
      }),
    ).toThrow("configuration is invalid");
  });

  it("binds only after one-time state consumption and fixed caller verification", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind, events } = harness({
      fetch: successfulFetch(requests),
    });
    const begun = await authorization.begin(authority);
    const installUrl = new URL(begun.redirectUrl);
    expect(installUrl.origin + installUrl.pathname).toBe(
      "https://github.com/apps/autograph-app-builder/installations/new",
    );
    const state = installUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(state).not.toContain(authority.workspaceId);
    expect(state).not.toContain(authority.ownerUserId);

    const authorize = await authorization.complete(
      setupCallbackUrl(state!),
      authority,
    );
    expect(authorize.status).toBe("redirect");
    if (authorize.status !== "redirect") throw new Error("expected redirect");
    const authorizeUrl = new URL(authorize.redirectUrl);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const receipt = await authorization.complete(
      authorizationCallbackUrl(authorizeUrl.searchParams.get("state")!),
      authority,
    );
    expect(receipt).toMatchObject({
      version: 1,
      status: "bound",
      accountType: "Organization",
      repositorySelection: "selected",
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("github-user-token-sentinel-value");
    expect(serialized).not.toContain(config.clientSecret);
    expect(serialized).not.toContain("withAutograph");
    expect(events).toEqual([
      "membership",
      "state:create",
      "membership",
      "state:consume",
      "state:create",
      "membership",
      "state:consume",
      "membership",
      "installation:bind",
    ]);
    expect(bind).toHaveBeenCalledOnce();
    expect(requests.map(({ url }) => url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/installations?per_page=100&page=1",
    ]);
    expect(String(requests[0]?.init?.body)).toContain("client_secret=");
    expect(String(requests[0]?.init?.body)).toContain("code_verifier=");
    expect(String(requests[1]?.init?.headers)).not.toContain(
      "github-user-token-sentinel-value",
    );
  });

  it("returns an allowlisted OAuth denial to the signed destination without leaking details", async () => {
    const { authorization } = harness();
    const begun = await authorization.begin(authority, { returnTo: "/" });
    const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
    const authorize = await authorization.complete(
      setupCallbackUrl(installState),
      authority,
    );
    if (authorize.status !== "redirect") throw new Error("expected redirect");
    const state = new URL(authorize.redirectUrl).searchParams.get("state")!;
    await expect(
      authorization.complete(
        `https://builder.example/github/installations/callback?error=access_denied&error_description=secret-provider-detail&iss=https%3A%2F%2Fgithub.example&iss=https%3A%2F%2Fgithub.example&state=${encodeURIComponent(state)}`,
        authority,
      ),
    ).rejects.toMatchObject({
      stage: "oauth-callback-error",
      category: "access_denied",
      returnState: { returnTo: "/" },
    });
  });

  it("fails replay before another provider request or binding", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    await authorization.complete(
      authorizationCallbackUrl(authorizeState),
      authority,
    );
    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority,
      ),
    ).rejects.toThrow("GitHub App installation authorization failed.");
    expect(requests).toHaveLength(3);
    expect(bind).toHaveBeenCalledOnce();
  });

  it("derives the selected installation after GitHub returns only code and state", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority,
      ),
    ).resolves.toMatchObject({ setupAction: "install", status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("binds an active all-repositories installation to the same tenant", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind, events } = harness({
      fetch: successfulFetch(requests, "all"),
    });
    const { authorizeState } = await prepareAuthorization(authorization);

    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority,
      ),
    ).resolves.toMatchObject({
      status: "bound",
      repositorySelection: "all",
    });
    expect(events).toContain("installation:bind");
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ authority }));
  });

  it("rebinds an existing installation after a signed GitHub update callback", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const begun = await authorization.begin(authority);
    const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
    const authorize = await authorization.complete(
      setupCallbackUrl(installState, "update"),
      authority,
    );
    if (authorize.status !== "redirect") throw new Error("expected redirect");

    await expect(
      authorization.complete(
        authorizationCallbackUrl(
          new URL(authorize.redirectUrl).searchParams.get("state")!,
        ),
        authority,
      ),
    ).resolves.toMatchObject({ status: "bound", setupAction: "update" });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("accepts GitHub's OAuth callback shape with signed installation metadata", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const begun = await authorization.begin(authority);
    const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
    const authorize = await authorization.complete(
      setupCallbackUrl(installState, "update"),
      authority,
    );
    if (authorize.status !== "redirect") throw new Error("expected redirect");
    const callback = new URL(
      authorizationCallbackUrl(
        new URL(authorize.redirectUrl).searchParams.get("state")!,
      ),
    );
    callback.searchParams.set("installation_id", "98765");
    callback.searchParams.set("setup_action", "update");
    callback.searchParams.set("iss", "https://github.com");

    await expect(
      authorization.complete(callback.toString(), authority),
    ).resolves.toMatchObject({
      status: "bound",
      setupAction: "update",
    });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("accepts a bounded opaque GitHub OAuth code with issuer identification", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    const callback = new URL(authorizationCallbackUrl(authorizeState));
    callback.searchParams.set("code", "c".repeat(1_024));
    callback.searchParams.set("iss", "https://github.com");

    await expect(
      authorization.complete(callback.toString(), authority),
    ).resolves.toMatchObject({ status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("rejects a cross-workspace state and inactive membership before exchange", async () => {
    const request = vi.fn<typeof fetch>();
    const active = harness({ fetch: request });
    const begun = await active.authorization.begin(authority);
    const state = new URL(begun.redirectUrl).searchParams.get("state")!;
    await expect(
      active.authorization.complete(setupCallbackUrl(state), {
        ...authority,
        workspaceId: "workspace_other",
      }),
    ).rejects.toThrow("GitHub App installation authorization failed.");
    expect(request).not.toHaveBeenCalled();

    const inactive = harness({ membership: () => false, fetch: request });
    await expect(inactive.authorization.begin(authority)).rejects.toThrow(
      "GitHub App installation authorization failed.",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when installation OAuth returns a code without tenant-bound state", async () => {
    const request = vi.fn<typeof fetch>();
    const { authorization, bind } = harness({ fetch: request });

    let error: unknown;
    try {
      await authorization.complete(
        "https://builder.example/github/installations/callback?code=one-time-code",
        authority,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(githubInstallationAuthorizationDiagnostic(error)).toMatchObject({
      stage: "callback-state-validation",
      callback: { queryKeys: ["code"], statePresent: false },
      stateValidation: { substage: "callback-parse" },
    });
    expect(request).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("classifies a tampered OAuth state without retaining callback secrets", async () => {
    const request = vi.fn<typeof fetch>();
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);
    const replacement = authorizeState.endsWith("A") ? "B" : "A";
    const callback = authorizationCallbackUrl(
      `${authorizeState.slice(0, -1)}${replacement}`,
    );

    let error: unknown;
    try {
      await authorization.complete(callback, authority);
    } catch (caught) {
      error = caught;
    }

    const diagnostic = githubInstallationAuthorizationDiagnostic(error);
    expect(diagnostic).toMatchObject({
      stage: "callback-state-validation",
      callback: { queryKeys: ["code", "state"], statePresent: true },
      stateValidation: {
        substage: "state-signature",
        stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(authorizeState);
    expect(JSON.stringify(diagnostic)).not.toContain("one-time-code");
    expect(request).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("classifies tenant authority drift before state consumption", async () => {
    const request = vi.fn<typeof fetch>();
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);

    let error: unknown;
    try {
      await authorization.complete(authorizationCallbackUrl(authorizeState), {
        ...authority,
        workspaceId: "workspace_other",
      });
    } catch (caught) {
      error = caught;
    }

    expect(githubInstallationAuthorizationDiagnostic(error)).toMatchObject({
      stage: "callback-state-validation",
      stateValidation: {
        substage: "state-authority-digest",
        stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("fails closed when a code is mixed with setup callback parameters", async () => {
    const request = vi.fn<typeof fetch>();
    const { authorization, bind } = harness({ fetch: request });
    const begun = await authorization.begin(authority);
    const state = new URL(begun.redirectUrl).searchParams.get("state")!;
    const callback = new URL(setupCallbackUrl(state));
    callback.searchParams.set("code", "one-time-code");

    await expect(
      authorization.complete(callback.toString(), authority),
    ).rejects.toThrow("GitHub App installation authorization failed.");
    expect(request).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("retains duplicate callback-key rejection with safe cardinality diagnostics", async () => {
    const request = vi.fn<typeof fetch>();
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);
    const callback = new URL(authorizationCallbackUrl(authorizeState));
    callback.searchParams.append("code", "second-code");

    let error: unknown;
    try {
      await authorization.complete(callback.toString(), authority);
    } catch (caught) {
      error = caught;
    }
    expect(githubInstallationAuthorizationDiagnostic(error)).toMatchObject({
      stage: "callback-state-validation",
      callback: {
        queryKeys: ["code", "state"],
        keyCounts: { code: 2, state: 1 },
        unknownKeyCount: 0,
        codePresent: true,
        codeLength: "one-time-code".length,
      },
      stateValidation: {
        substage: "callback-parse",
        callbackParseReason: "duplicate-key",
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("tolerates repeated provider issuer extensions before exchange", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    const callback = new URL(authorizationCallbackUrl(authorizeState));
    callback.searchParams.append("iss", "https://github.example");
    callback.searchParams.append("iss", "https://github.example");

    await expect(
      authorization.complete(callback.toString(), authority),
    ).resolves.toMatchObject({ status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(3);
  });

  it("tolerates provider extensions on an installation-only callback", async () => {
    const request = vi.fn<typeof fetch>();
    const { authorization, bind } = harness({ fetch: request });
    const begun = await authorization.begin(authority);
    const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
    const callback = new URL(setupCallbackUrl(installState));
    callback.searchParams.append("iss", "https://github.example");
    callback.searchParams.append("iss", "https://github.example");

    await expect(
      authorization.complete(callback.toString(), authority),
    ).resolves.toMatchObject({ status: "redirect" });
    expect(request).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("tolerates future provider extensions without retaining their names or values", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    const callback = new URL(authorizationCallbackUrl(authorizeState));
    callback.searchParams.set("provider-detail-sentinel", "secret-value");

    const receipt = await authorization.complete(
      callback.toString(),
      authority,
    );
    expect(receipt).toMatchObject({ status: "bound" });
    expect(JSON.stringify(receipt)).not.toContain("provider-detail-sentinel");
    expect(JSON.stringify(receipt)).not.toContain("secret-value");
    expect(bind).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(3);
  });

  it("fails closed on provider drift without leaking provider responses", async () => {
    const request = vi.fn<typeof fetch>(async (resource) => {
      if (String(resource).includes("access_token")) {
        return Response.json({
          access_token: "github-user-token-sentinel-value",
          token_type: "bearer",
          scope: "",
          unexpected: "provider-drift-sentinel",
        });
      }
      throw new Error("must not continue");
    });
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);
    let message = "";
    let error: unknown;
    try {
      await authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority,
      );
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
      error = caught;
    }
    expect(message).toBe("GitHub App installation authorization failed.");
    expect(message).not.toContain("provider-drift-sentinel");
    expect(message).not.toContain("github-user-token-sentinel-value");
    expect(githubInstallationAuthorizationDiagnostic(error)).toEqual({
      stage: "token-response-schema",
    });
    expect(bind).not.toHaveBeenCalled();
  });

  it("classifies a token exchange failure without retaining provider data", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: "bad_verification_code",
          error_description: "provider-detail-sentinel",
        },
        { status: 400 },
      ),
    );
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);

    let error: unknown;
    try {
      await authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(githubInstallationAuthorizationDiagnostic(error)).toEqual({
      stage: "token-exchange-non-2xx",
      category: "bad_verification_code",
    });
    expect(String(error)).not.toContain("provider-detail-sentinel");
    expect(bind).not.toHaveBeenCalled();
  });

  it("classifies a 2xx OAuth error response without retaining provider data", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        error: "redirect_uri_mismatch",
        error_description: "provider-detail-sentinel",
      }),
    );
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);
    let error: unknown;
    try {
      await authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority,
      );
    } catch (caught) {
      error = caught;
    }

    expect(githubInstallationAuthorizationDiagnostic(error)).toEqual({
      stage: "token-exchange-oauth-error",
      category: "redirect_uri_mismatch",
    });
    expect(String(error)).not.toContain("provider-detail-sentinel");
    expect(bind).not.toHaveBeenCalled();
  });

  it("requires selected, active, exact-app installation identity", async () => {
    const request = vi.fn<typeof fetch>(async (resource) => {
      const url = String(resource);
      if (url.includes("access_token"))
        return Response.json({
          access_token: "github-user-token-sentinel-value",
          token_type: "bearer",
          scope: "",
        });
      if (url.endsWith("/user"))
        return Response.json({ id: 321, login: "installer" });
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 98765,
            app_id: 99999,
            app_slug: "autograph-app-builder",
            target_type: "User",
            repository_selection: "all",
            suspended_at: "2026-08-28T12:00:00Z",
            account: { id: 321, login: "installer", type: "User" },
          },
        ],
      });
    });
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);
    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority,
      ),
    ).rejects.toThrow("GitHub App installation authorization failed.");
    expect(bind).not.toHaveBeenCalled();
  });
});
