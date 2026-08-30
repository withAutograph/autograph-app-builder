import { describe, expect, it, vi } from "vitest";

import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  createGitHubAppInstallationAuthorization,
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

function setupCallbackUrl(state: string) {
  const url = new URL("https://builder.example/github/installations/callback");
  url.searchParams.set("installation_id", "98765");
  url.searchParams.set("setup_action", "install");
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

    await expect(
      authorization.complete(
        "https://builder.example/github/installations/callback?code=one-time-code",
        authority,
      ),
    ).rejects.toThrow("GitHub App installation authorization failed.");
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
    try {
      await authorization.complete(
        authorizationCallbackUrl(authorizeState),
        authority,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("GitHub App installation authorization failed.");
    expect(message).not.toContain("provider-drift-sentinel");
    expect(message).not.toContain("github-user-token-sentinel-value");
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
