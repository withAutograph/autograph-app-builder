import { describe, expect, it, vi } from "vitest";

import type { ProviderEmulation } from "../integrations/local-provider-emulation";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  createGitHubAppInstallationAuthorization,
  githubInstallationAuthorizationDiagnostic,
  readGitHubAppInstallationEnvironment,
} from "./github-app-installation";
import type { GitHubInstallationAuthorizationStateStore } from "./github-app-installation";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_one",
  workspaceId: "workspace_one",
};

const config = {
  appId: "12345",
  appSlug: "autograph-app-builder",
  clientId: "Iv1_app_client",
  clientSecret: "client-secret-sentinel-value",
  issuer: authority.issuer,
  resource: authority.audience,
  stateSecret: "state-secret-sentinel-value-with-32-characters",
};

function harness(input?: {
  membership?: () => boolean;
  fetch?: typeof fetch;
  emulation?: ProviderEmulation;
}) {
  const states = new Map<
    string,
    { consumed: boolean; authorityDigest: string }
  >();
  const events: string[] = [];
  const stateStore: GitHubInstallationAuthorizationStateStore = {
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
    async create(value) {
      events.push("state:create");
      states.set(value.stateDigest, {
        consumed: false,
        authorityDigest: value.authorityDigest,
      });
    },
  };
  const bind = vi.fn<HostedGitHubInstallationStore["bind"]>(async (value) => {
    events.push("installation:bind");
    return { ...value.binding, active: true, updatedAt: value.now };
  });
  const installationStore: HostedGitHubInstallationStore = {
    bind,
    async read() {
      return undefined;
    },
  };
  const membership = vi.fn(async () => {
    events.push("membership");
    return input?.membership?.() ?? true;
  });
  const authorization = createGitHubAppInstallationAuthorization({
    config,
    emulation: input?.emulation,
    fetch: input?.fetch,
    installationStore,
    membership: { isActiveMember: membership },
    nonce: () => "n".repeat(43),
    now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    stateStore,
  });
  return { authorization, bind, events, membership };
}

function setupCallbackUrl(
  state: string,
  setupAction: "install" | "update" = "install"
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
  returnState: { returnTo: "/" | `/handoff/${string}`; resumeKey?: string } = {
    returnTo: "/",
  }
) {
  const begun = await authorization.begin(authority, returnState);
  const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
  const authorize = await authorization.complete(
    setupCallbackUrl(installState),
    authority
  );
  if (authorize.status !== "redirect") {
    throw new Error("expected redirect");
  }
  const authorizeUrl = new URL(authorize.redirectUrl);
  expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
    "https://github.com/login/oauth/authorize"
  );
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(
    /^[A-Za-z0-9_-]{43}$/u
  );
  return {
    authorizeState: authorizeUrl.searchParams.get("state")!,
    begun,
    installState,
  };
}

function successfulFetch(
  seen: { url: string; init?: RequestInit }[],
  repositorySelection: "all" | "selected" = "selected"
) {
  return vi.fn<typeof fetch>(async (resource, init) => {
    const url = String(resource);
    seen.push({ init, url });
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "github-user-token-sentinel-value",
        scope: "",
        token_type: "bearer",
      });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: 321, login: "installer" });
    }
    if (
      url === "https://api.github.com/user/installations?per_page=100&page=1"
    ) {
      return Response.json({
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
        total_count: 1,
      });
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe("public GitHub App installation authorization", () => {
  it("reads one exact Preview-only environment contract", () => {
    expect(
      readGitHubAppInstallationEnvironment({
        BETTER_AUTH_URL: config.issuer,
        GITHUB_APP_CLIENT_ID: config.clientId,
        GITHUB_APP_CLIENT_SECRET: config.clientSecret,
        GITHUB_APP_ID: config.appId,
        GITHUB_APP_INSTALL_STATE_SECRET: config.stateSecret,
        GITHUB_APP_SLUG: config.appSlug,
        MCP_RESOURCE_URL: config.resource,
      })
    ).toEqual(config);
    expect(() =>
      readGitHubAppInstallationEnvironment({
        BETTER_AUTH_URL: config.issuer,
        GITHUB_APP_CLIENT_ID: config.clientId,
        GITHUB_APP_CLIENT_SECRET: config.clientSecret,
        GITHUB_APP_ID: config.appId,
        GITHUB_APP_INSTALL_STATE_SECRET: config.stateSecret,
        GITHUB_APP_SLUG: config.appSlug,
        GITHUB_TOKEN: "ambient-token",
        MCP_RESOURCE_URL: config.resource,
      })
    ).toThrow("configuration is invalid");
  });

  it("binds only after one-time state consumption and fixed caller verification", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind, events } = harness({
      fetch: successfulFetch(requests),
    });
    const begun = await authorization.begin(authority);
    const installUrl = new URL(begun.redirectUrl);
    expect(installUrl.origin + installUrl.pathname).toBe(
      "https://github.com/apps/autograph-app-builder/installations/new"
    );
    const state = installUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(state).not.toContain(authority.workspaceId);
    expect(state).not.toContain(authority.ownerUserId);

    const authorize = await authorization.complete(
      setupCallbackUrl(state!),
      authority
    );
    expect(authorize.status).toBe("redirect");
    if (authorize.status !== "redirect") {
      throw new Error("expected redirect");
    }
    const authorizeUrl = new URL(authorize.redirectUrl);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const receipt = await authorization.complete(
      authorizationCallbackUrl(authorizeUrl.searchParams.get("state")!),
      authority
    );
    expect(receipt).toMatchObject({
      accountType: "Organization",
      repositorySelection: "selected",
      status: "bound",
      version: 1,
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
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      client_secret: config.clientSecret,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(String(requests[1]?.init?.headers)).not.toContain(
      "github-user-token-sentinel-value"
    );
  });

  it("preserves the embedded Preview emulator route for authorization and API requests", async () => {
    const emulation: ProviderEmulation = {
      branch: "branch",
      canonicalOrigin: "https://builder.example",
      githubClientId: config.clientId,
      githubClientSecret: config.clientSecret,
      githubOrigin: "https://builder.example/api/emulate/github",
      githubRepository: "autograph-local/demo-app",
      mode: "preview",
      namespace: "repository:project:branch:seed-v2",
      relaySecret: "preview-relay-secret-sentinel-value-32",
      token: "preview-provider-token-sentinel",
      vercelClientId: "preview-vercel-client",
      vercelClientSecret: "preview-vercel-secret-sentinel-value",
      vercelOrigin: "https://builder.example/api/emulate/vercel",
    };
    const requests: string[] = [];
    const request = vi.fn<typeof fetch>(async (resource) => {
      const url = String(resource);
      requests.push(url);
      if (url.endsWith("/login/oauth/access_token")) {
        return Response.json({
          access_token: "github-user-token-sentinel-value",
          token_type: "bearer",
          scope: "",
        });
      }
      if (url.endsWith("/user")) {
        return Response.json({ id: 321, login: "installer" });
      }
      return Response.json({
        account: {
          id: 149546148,
          login: "withAutograph",
          type: "Organization",
        },
        app_id: 12345,
        app_slug: "autograph-app-builder",
        id: 98765,
        repository_selection: "selected",
        suspended_at: null,
        target_type: "Organization",
      });
    });
    const { authorization, bind } = harness({
      emulation,
      fetch: request,
    });
    const begun = await authorization.begin(authority);
    expect(new URL(begun.redirectUrl).pathname).toBe(
      "/local-connections/github"
    );
    const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
    const authorize = await authorization.complete(
      setupCallbackUrl(installState),
      authority
    );
    if (authorize.status !== "redirect") {
      throw new Error("expected redirect");
    }
    const authorizeUrl = new URL(authorize.redirectUrl);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://builder.example/local-connections/github"
    );
    expect(authorizeUrl.searchParams.get("phase")).toBe("authorize");

    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeUrl.searchParams.get("state")!),
        authority
      )
    ).resolves.toMatchObject({ status: "bound" });
    expect(requests).toEqual([
      "https://builder.example/api/emulate/github/login/oauth/access_token",
      "https://builder.example/api/emulate/github/user",
      "https://builder.example/api/emulate/github/repos/autograph-local/demo-app/installation",
    ]);
    expect(bind).toHaveBeenCalledOnce();
  });

  it("returns an allowlisted OAuth denial to the signed destination without leaking details", async () => {
    const { authorization } = harness();
    const begun = await authorization.begin(authority, { returnTo: "/" });
    const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
    const authorize = await authorization.complete(
      setupCallbackUrl(installState),
      authority
    );
    if (authorize.status !== "redirect") {
      throw new Error("expected redirect");
    }
    const state = new URL(authorize.redirectUrl).searchParams.get("state")!;
    await expect(
      authorization.complete(
        `https://builder.example/github/installations/callback?error=access_denied&error_description=secret-provider-detail&state=${encodeURIComponent(state)}`,
        authority
      )
    ).rejects.toMatchObject({
      category: "access_denied",
      returnState: { returnTo: "/" },
      stage: "oauth-callback-error",
    });
  });

  it.each(["/", "/handoff/ed5bc83d-a08f-42be-9635-4677fa7bdb32"] as const)(
    "preserves %s through signed state and fails replay before another provider request",
    async (returnTo) => {
      const requests: { url: string; init?: RequestInit }[] = [];
      const { authorization, bind } = harness({
        fetch: successfulFetch(requests),
      });
      const returnState = {
        resumeKey: "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0",
        returnTo,
      };
      const { authorizeState } = await prepareAuthorization(
        authorization,
        returnState
      );
      await authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority
      );
      await expect(
        authorization.complete(
          authorizationCallbackUrl(authorizeState),
          authority
        )
      ).rejects.toMatchObject({
        message: "GitHub App installation authorization failed.",
        returnState,
      });
      expect(requests).toHaveLength(3);
      expect(bind).toHaveBeenCalledOnce();
    }
  );

  it("derives the selected installation after GitHub returns only code and state", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority
      )
    ).resolves.toMatchObject({ setupAction: "install", status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("binds an active all-repositories installation to the same tenant", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind, events } = harness({
      fetch: successfulFetch(requests, "all"),
    });
    const { authorizeState } = await prepareAuthorization(authorization);

    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority
      )
    ).resolves.toMatchObject({
      repositorySelection: "all",
      status: "bound",
    });
    expect(events).toContain("installation:bind");
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ authority }));
  });

  it("rebinds an existing installation after a signed GitHub update callback", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const begun = await authorization.begin(authority);
    const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
    const authorize = await authorization.complete(
      setupCallbackUrl(installState, "update"),
      authority
    );
    if (authorize.status !== "redirect") {
      throw new Error("expected redirect");
    }

    await expect(
      authorization.complete(
        authorizationCallbackUrl(
          new URL(authorize.redirectUrl).searchParams.get("state")!
        ),
        authority
      )
    ).resolves.toMatchObject({ setupAction: "update", status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("accepts GitHub's OAuth callback shape with signed installation metadata", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const begun = await authorization.begin(authority);
    const installState = new URL(begun.redirectUrl).searchParams.get("state")!;
    const authorize = await authorization.complete(
      setupCallbackUrl(installState, "update"),
      authority
    );
    if (authorize.status !== "redirect") {
      throw new Error("expected redirect");
    }
    const callback = new URL(
      authorizationCallbackUrl(
        new URL(authorize.redirectUrl).searchParams.get("state")!
      )
    );
    callback.searchParams.set("installation_id", "98765");
    callback.searchParams.set("setup_action", "update");

    await expect(
      authorization.complete(callback.toString(), authority)
    ).resolves.toMatchObject({
      setupAction: "update",
      status: "bound",
    });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("accepts a provider-owned opaque GitHub OAuth code without a local size bound", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    const callback = new URL(authorizationCallbackUrl(authorizeState));
    callback.searchParams.set("code", "c".repeat(8192));

    await expect(
      authorization.complete(callback.toString(), authority)
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
      })
    ).rejects.toThrow("GitHub App installation authorization failed.");
    expect(request).not.toHaveBeenCalled();

    const inactive = harness({ fetch: request, membership: () => false });
    await expect(inactive.authorization.begin(authority)).rejects.toThrow(
      "GitHub App installation authorization failed."
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
        authority
      );
    } catch (error) {
      error = error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(githubInstallationAuthorizationDiagnostic(error)).toMatchObject({
      callback: { queryKeys: ["code"], statePresent: false },
      stage: "callback-state-validation",
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
      `${authorizeState.slice(0, -1)}${replacement}`
    );

    let error: unknown;
    try {
      await authorization.complete(callback, authority);
    } catch (error) {
      error = error;
    }

    const diagnostic = githubInstallationAuthorizationDiagnostic(error);
    expect(diagnostic).toMatchObject({
      callback: { queryKeys: ["code", "state"], statePresent: true },
      stage: "callback-state-validation",
      stateValidation: {
        stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        substage: "state-signature",
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
    } catch (error) {
      error = error;
    }

    expect(githubInstallationAuthorizationDiagnostic(error)).toMatchObject({
      stage: "callback-state-validation",
      stateValidation: {
        stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        substage: "state-authority-digest",
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
      authorization.complete(callback.toString(), authority)
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
    } catch (error) {
      error = error;
    }
    expect(githubInstallationAuthorizationDiagnostic(error)).toMatchObject({
      callback: {
        codeLength: "one-time-code".length,
        codePresent: true,
        keyCounts: { code: 2, state: 1 },
        queryKeys: ["code", "state"],
        unknownKeyCount: 0,
      },
      stage: "callback-state-validation",
      stateValidation: {
        callbackParseReason: "duplicate-key",
        substage: "callback-parse",
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("accepts the live RFC 9207 code, iss, and state callback shape", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    const callback = new URL(authorizationCallbackUrl(authorizeState));
    callback.searchParams.set("iss", "https://github.com");
    expect([...callback.searchParams.keys()].toSorted()).toEqual([
      "code",
      "iss",
      "state",
    ]);
    expect(
      Object.fromEntries(
        [...new Set(callback.searchParams.keys())].map((key) => [
          key,
          callback.searchParams.getAll(key).length,
        ])
      )
    ).toEqual({ code: 1, iss: 1, state: 1 });

    await expect(
      authorization.complete(callback.toString(), authority)
    ).resolves.toMatchObject({ status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("tolerates repeated provider issuer extensions", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    const callback = new URL(authorizationCallbackUrl(authorizeState));
    callback.searchParams.append("iss", "https://github.example");
    callback.searchParams.append("iss", "https://github.example");

    await expect(
      authorization.complete(callback.toString(), authority)
    ).resolves.toMatchObject({ status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
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
      authorization.complete(callback.toString(), authority)
    ).resolves.toMatchObject({ status: "redirect" });
    expect(request).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("tolerates repeated future provider extension callback fields", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const { authorization, bind } = harness({
      fetch: successfulFetch(requests),
    });
    const { authorizeState } = await prepareAuthorization(authorization);
    const callback = new URL(authorizationCallbackUrl(authorizeState));
    callback.searchParams.set("provider-detail-sentinel", "secret-value");
    callback.searchParams.append("provider-detail-sentinel", "second-value");

    await expect(
      authorization.complete(callback.toString(), authority)
    ).resolves.toMatchObject({ status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("tolerates future OAuth token response extension fields", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fallback = successfulFetch(requests);
    const request = vi.fn<typeof fetch>(async (resource, init) => {
      if (String(resource).includes("access_token")) {
        requests.push({ init, url: String(resource) });
        return Response.json({
          access_token: "github-user-token-sentinel-value",
          scope: "",
          token_type: "bearer",
          unexpected: "provider-drift-sentinel",
        });
      }
      return fallback(resource, init);
    });
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);
    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority
      )
    ).resolves.toMatchObject({ status: "bound" });
    expect(bind).toHaveBeenCalledOnce();
  });

  it("classifies a token exchange failure without retaining provider data", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: "bad_verification_code",
          error_description: "provider-detail-sentinel",
        },
        { status: 400 }
      )
    );
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);

    let error: unknown;
    try {
      await authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority
      );
    } catch (error) {
      error = error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(githubInstallationAuthorizationDiagnostic(error)).toEqual({
      category: "bad_verification_code",
      stage: "token-exchange-non-2xx",
    });
    expect(String(error)).not.toContain("provider-detail-sentinel");
    expect(bind).not.toHaveBeenCalled();
  });

  it("classifies a 2xx OAuth error response without retaining provider data", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        error: "redirect_uri_mismatch",
        error_description: "provider-detail-sentinel",
      })
    );
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);
    let error: unknown;
    try {
      await authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority
      );
    } catch (error) {
      error = error;
    }

    expect(githubInstallationAuthorizationDiagnostic(error)).toEqual({
      category: "redirect_uri_mismatch",
      stage: "token-exchange-oauth-error",
    });
    expect(String(error)).not.toContain("provider-detail-sentinel");
    expect(bind).not.toHaveBeenCalled();
  });

  it("requires selected, active, exact-app installation identity", async () => {
    const request = vi.fn<typeof fetch>(async (resource) => {
      const url = String(resource);
      if (url.includes("access_token")) {
        return Response.json({
          access_token: "github-user-token-sentinel-value",
          token_type: "bearer",
          scope: "",
        });
      }
      if (url.endsWith("/user")) {
        return Response.json({ id: 321, login: "installer" });
      }
      return Response.json({
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
        total_count: 1,
      });
    });
    const { authorization, bind } = harness({ fetch: request });
    const { authorizeState } = await prepareAuthorization(authorization);
    await expect(
      authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority
      )
    ).rejects.toThrow("GitHub App installation authorization failed.");
    expect(bind).not.toHaveBeenCalled();
  });
});
