import { describe, expect, it, vi } from "vitest";
import { createHostedOperatorNormalAuthTransport } from "./hosted-operator-normal-auth-transport";
import type { NormalAuthTransportConfiguration } from "./hosted-operator-normal-auth-transport";
import type { HostedOperatorContext } from "./hosted-operator-service";

const origin = "https://public.example.com";
const configuration: NormalAuthTransportConfiguration = {
  applications: {
    "spend-review": {
      accessRoles: ["requester"],
      appDatabase: {
        database: "app_db",
        migratorRole: "app_migrator",
        runtimeRole: "app_runtime",
        resourceId: "app-resource",
      },
      branch: "feature",
      projectId: "app-project",
    },
  },
  operator: {
    deploymentId: "operator-deployment",
    environment: "preview",
    origin: "https://operator.example.com",
    projectId: "operator-project",
  },
  gateway: { publicOrigin: origin },
  nativeNeon: {
    configuration: {
      operator: {
        audience: "https://vercel.com/team",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "operator-project",
        environment: "preview",
      },
    },
  },
  teamId: "team",
};
const authority = {
  audience: "https://builder.example.com/mcp",
  issuer: "https://builder.example.com/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context: HostedOperatorContext = {
  authority,
  ownerContext: {
    kind: "direct",
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority,
    principal: { ...authority, scopes: ["autograph:get"] },
    sessionId: "session",
  },
  target: {
    appId: "spend-review",
    branch: "feature",
    environment: "preview",
    installationId: "installation",
    projectId: "app-project",
    scopeId: "team",
    scopeType: "team",
    sessionId: "session",
  },
};
const io = () => ({
  getOidc: vi.fn(async () => await Promise.resolve("private-native-token")),
  verifyOidc: vi.fn(async () => {
    await Promise.resolve();
  }),
  fetch: vi.fn<typeof fetch>(
    async () =>
      await Promise.resolve(
        Response.json(
          { normal: true },
          { headers: { "set-cookie": "normal-session=issued-by-auth; Secure; HttpOnly; Path=/" } },
        ),
      ),
  ),
});
const dependencies = () => ({
  configuration,
  context,
  origin,
  assertPlanningAuthorized: vi.fn(async () => {
    await Promise.resolve();
  }),
  assertCurrentOwner: vi.fn(async () => {
    await Promise.resolve();
  }),
});
const requestHeaders = {
  origin,
  accept: "application/json",
  cookie: "normal-session=private-cookie",
};
const getSession = `${origin}/api/auth/get-session?disableRefresh=true&disableCookieCache=true`;

describe("normal Auth native transport", () => {
  it("preserves real normal cookies and Auth-issued response cookies while using verified native OIDC protection", async () => {
    const calls = io();
    const owner = dependencies();
    const transport = await createHostedOperatorNormalAuthTransport(owner, calls);
    const response = await transport(getSession, { headers: requestHeaders });
    expect(response.headers.getSetCookie()).toEqual([
      "normal-session=issued-by-auth; Secure; HttpOnly; Path=/",
    ]);
    const headers = new Headers(calls.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("cookie")).toBe("normal-session=private-cookie");
    expect(headers.get("origin")).toBe(origin);
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe("private-native-token");
    expect(headers.has("authorization")).toBe(false);
    expect(calls.getOidc).toHaveBeenCalledWith({ project: "operator-project", team: "team" });
    expect(calls.verifyOidc).toHaveBeenCalledWith(
      "private-native-token",
      configuration.nativeNeon.configuration.operator,
    );
    expect(calls.fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("freezes a caller URL before awaiting owner or native credential checks", async () => {
    const calls = io();
    const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
    const address = new URL(getSession);
    const pending = transport(address, { headers: requestHeaders });
    address.hostname = "other.example.com";
    await pending;
    expect(calls.fetch.mock.calls[0]?.[0]).toEqual(new URL(getSession));
  });
  it("checks provider authority once and refreshes cheap owner authority for every cookie request", async () => {
    const calls = io();
    const owner = dependencies();
    const transport = await createHostedOperatorNormalAuthTransport(owner, calls);
    await transport(getSession, { headers: requestHeaders });
    await transport(
      `${origin}/api/auth/organization/list-members?organizationId=org-one&filterField=userId&filterValue=actor&filterOperator=eq`,
      { headers: requestHeaders },
    );
    expect(owner.assertPlanningAuthorized).toHaveBeenCalledTimes(1);
    expect(owner.assertCurrentOwner.mock.calls.length).toBeGreaterThanOrEqual(2);
    owner.assertCurrentOwner.mockRejectedValueOnce(new Error("owner_revoked"));
    await expect(transport(getSession, { headers: requestHeaders })).rejects.toThrow(
      "owner_revoked",
    );
    expect(calls.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    "https://other.example.com/api/auth/sign-in/email",
    `${origin}/api/provider/anything`,
    `${origin}/api/auth/organization/add-member`,
    `${origin}/api/auth/sign-in/email?redirect=https://other.example.com`,
  ])("does not forward cookies to an unapproved capability: %s", async (url) => {
    const calls = io();
    const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
    await expect(
      transport(url, {
        method: "POST",
        headers: { ...requestHeaders, "content-type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow("resource_mismatch");
    expect(calls.getOidc).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
  });
  it("rejects supplied authority headers and GET requests that could refresh or trust cached sessions", async () => {
    const calls = io();
    const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
    await expect(
      transport(getSession, { headers: { ...requestHeaders, authorization: "Bearer unapproved" } }),
    ).rejects.toThrow("resource_mismatch");
    await expect(
      transport(`${origin}/api/auth/get-session`, { headers: requestHeaders }),
    ).rejects.toThrow("resource_mismatch");
    await expect(
      transport(getSession, {
        headers: { ...requestHeaders, origin: "https://other.example.com" },
      }),
    ).rejects.toThrow("resource_mismatch");
    expect(calls.fetch).not.toHaveBeenCalled();
  });
  it("keeps the actual POST body and fixed method for Request inputs", async () => {
    const calls = io();
    const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
    const request = new Request(`${origin}/api/auth/organization/set-active`, {
      method: "POST",
      headers: { ...requestHeaders, "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "org-one" }),
    });
    await transport(request);
    const sent = new Request(
      calls.fetch.mock.calls[0]?.[0] ?? "https://unused.example.com",
      calls.fetch.mock.calls[0]?.[1],
    );
    expect(await sent.json()).toEqual({ organizationId: "org-one" });
  });
  it("rejects native token verification failure and redirects before accepting an Auth response", async () => {
    const calls = io();
    const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
    calls.verifyOidc.mockRejectedValueOnce(new Error("native_source_mismatch"));
    await expect(transport(getSession, { headers: requestHeaders })).rejects.toThrow(
      "native_source_mismatch",
    );
    expect(calls.fetch).not.toHaveBeenCalled();
    calls.fetch.mockResolvedValueOnce(Response.redirect("https://other.example.com/auth"));
    await expect(transport(getSession, { headers: requestHeaders })).rejects.toThrow(
      "resource_mismatch",
    );
  });
  it("does not open transport authority for a different application, owner scope or origin", async () => {
    const calls = io();
    await expect(
      createHostedOperatorNormalAuthTransport(
        { ...dependencies(), origin: "https://other.example.com" },
        calls,
      ),
    ).rejects.toThrow("resource_mismatch");
    await expect(
      createHostedOperatorNormalAuthTransport(
        {
          ...dependencies(),
          context: { ...context, target: { ...context.target, projectId: "other-project" } },
        },
        calls,
      ),
    ).rejects.toThrow("resource_mismatch");
    expect(calls.getOidc).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
  });
});
