import { describe, expect, it, vi } from "vitest";
import type { verifyVercelOidcToken } from "@vercel/oidc";
import { createHostedOperatorNormalAuthTransport } from "./hosted-operator-normal-auth-transport";
import type { NormalAuthTransportConfiguration } from "./hosted-operator-normal-auth-transport";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { createHostedOperatorRealmHttpTransport } from "./hosted-operator-realm-http-transport";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

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

describe("private Realm readback native transport", () => {
  const endpointOrigin = "https://immutable-gateway.example.com";
  const readback = `${endpointOrigin}/api/auth/platform/operator-identity/readback`;
  const builderWorkload = {
    audience: "https://vercel.com/team",
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team",
    projectId: "builder-project",
    environment: "production" as const,
    subject: "owner:team:project:builder:environment:production",
  };
  // SAFETY: The private transport reads only gatewayOrigin and the two native workload policies supplied here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Unused source configuration fields are outside this focused transport fixture.
  const realmConfiguration = {
    ...configuration,
    gateway: { ...configuration.gateway, gatewayOrigin: "https://configured-gateway.example.com" },
    workloadPolicy: builderWorkload,
  } as HostedOperatorSourceConfiguration;

  const realmIo = () => {
    const verifyOidc = vi.fn<typeof verifyVercelOidcToken>();
    return {
      ...io(),
      // SAFETY: The transport awaits verification but never consumes its generic JWT payload; this spy models that boundary.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the SDK generic signature while retaining the focused mock controls.
      verifyOidc: verifyOidc as typeof verifyVercelOidcToken & typeof verifyOidc,
    };
  };

  it.each([undefined, "https://untrusted-caller.example.com"])(
    "derives POST Origin from the journal-pinned endpoint rather than caller metadata (%s)",
    async (callerOrigin) => {
      const native = realmIo();
      const transport = createHostedOperatorRealmHttpTransport(
        realmConfiguration,
        "builder",
        native,
        endpointOrigin,
      );
      const headers = new Headers({
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Bearer untrusted-caller-value",
      });
      if (callerOrigin !== undefined) {
        headers.set("origin", callerOrigin);
      }
      await transport(
        new Request(readback, {
          method: "POST",
          headers,
          body: new URLSearchParams({ proof: "private-proof" }),
        }),
      );
      const [sent] = native.fetch.mock.calls;
      const sentHeaders = new Headers(sent?.[1]?.headers);
      expect(sent?.[0]).toBeInstanceOf(URL);
      expect(sent?.[0] instanceof URL && sent[0].href).toBe(readback);
      expect(sentHeaders.get("origin")).toBe(endpointOrigin);
      expect(sentHeaders.get("x-vercel-trusted-oidc-idp-token")).toBe("private-native-token");
      expect(sentHeaders.get("authorization")).toBe("Bearer private-native-token");
      expect(sentHeaders.has("sec-fetch-site")).toBe(false);
      expect(sent?.[1]?.redirect).toBe("error");
      expect(sent?.[1]?.method).toBe("POST");
      expect(native.verifyOidc).toHaveBeenCalledWith("private-native-token", {
        audience: builderWorkload.audience,
        environment: builderWorkload.environment,
        issuer: builderWorkload.issuer,
        ownerId: builderWorkload.ownerId,
        projectId: builderWorkload.projectId,
      });
      const sentBody = sent?.[1]?.body;
      expect(sentBody).toBeInstanceOf(ArrayBuffer);
      if (!(sentBody instanceof ArrayBuffer)) {
        throw new Error("fixture_body_missing");
      }
      expect(Buffer.from(sentBody).toString()).toBe("proof=private-proof");
    },
  );

  it.each([undefined, "https://caller.example.com"])(
    "leaves JWKS GET Origin unchanged (%s)",
    async (callerOrigin) => {
      const native = realmIo();
      const headers = new Headers();
      if (callerOrigin !== undefined) {
        headers.set("origin", callerOrigin);
      }
      await createHostedOperatorRealmHttpTransport(
        realmConfiguration,
        "builder",
        native,
        endpointOrigin,
      )(`${endpointOrigin}/_platform/jwks.json`, { headers });
      expect(new Headers(native.fetch.mock.calls[0]?.[1]?.headers).get("origin")).toBe(
        callerOrigin ?? null,
      );
      expect(native.fetch.mock.calls[0]?.[1]?.method).toBe("GET");
      expect(new Headers(native.fetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(
        false,
      );
    },
  );

  it("rejects a cookie and native verification failure without sending readback", async () => {
    const native = realmIo();
    const transport = createHostedOperatorRealmHttpTransport(
      realmConfiguration,
      "builder",
      native,
      endpointOrigin,
    );
    await expect(
      transport(readback, {
        method: "POST",
        headers: { cookie: "normal-session=private-cookie" },
      }),
    ).rejects.toThrow();
    expect(native.fetch).not.toHaveBeenCalled();
    native.verifyOidc.mockRejectedValueOnce(new Error("native verification failed"));
    await expect(transport(readback, { method: "POST" })).rejects.toThrow();
    expect(native.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["https://other-gateway.example.com/api/auth/platform/operator-identity/readback", "POST"],
    ["https://configured-gateway.example.com/api/auth/platform/operator-identity/readback", "POST"],
    [`${readback}?unapproved=value`, "POST"],
    [`${endpointOrigin}/api/auth/platform/operator-link`, "POST"],
    [readback, "GET"],
    [`${endpointOrigin}/_platform/jwks.json`, "POST"],
  ])(
    "rejects requests outside the exact endpoint and fixed read routes (%s, %s)",
    async (url, method) => {
      const native = realmIo();
      await expect(
        createHostedOperatorRealmHttpTransport(
          realmConfiguration,
          "builder",
          native,
          endpointOrigin,
        )(url, { method }),
      ).rejects.toThrow();
      expect(native.getOidc).not.toHaveBeenCalled();
      expect(native.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("normal Auth native transport", () => {
  it("uses the actual configured Builder workload for private owner capture readback", async () => {
    const native = io();
    const builderWorkload = {
      audience: "https://vercel.com/team",
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "builder-project",
      environment: "production" as const,
      subject: "owner:team:project:builder:environment:production",
    };
    const transport = await createHostedOperatorNormalAuthTransport(
      {
        ...dependencies(),
        sourceHost: "builder",
        configuration: { ...configuration, workloadPolicy: builderWorkload },
      },
      native,
    );
    await transport(
      new URL("/api/auth/get-session?disableRefresh=true&disableCookieCache=true", origin),
      { headers: requestHeaders },
    );
    expect(native.getOidc).toHaveBeenCalledWith({
      project: builderWorkload.projectId,
      team: builderWorkload.ownerId,
    });
    expect(native.verifyOidc).toHaveBeenCalledWith("private-native-token", {
      audience: builderWorkload.audience,
      issuer: builderWorkload.issuer,
      ownerId: builderWorkload.ownerId,
      projectId: builderWorkload.projectId,
      environment: builderWorkload.environment,
    });
  });
  it("requires a configured Builder workload rather than borrowing Operator identity", async () => {
    const native = io();
    await expect(
      createHostedOperatorNormalAuthTransport({ ...dependencies(), sourceHost: "builder" }, native),
    ).rejects.toThrow();
    expect(native.getOidc).not.toHaveBeenCalled();
  });

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
  it("sends the supported normal owner proof form without following a callback", async () => {
    const calls = io();
    const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
    const form = new URLSearchParams({
      nonce: "a".repeat(64),
      ownerSessionId: "builder-owner-session",
      bootstrapPlanDigest: "sha256:approved-auth-bootstrap",
      authResourceId: "approved-auth-resource",
    });
    await transport(`${origin}/api/auth/platform/operator-link`, {
      method: "POST",
      headers: {
        ...requestHeaders,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const sent = new Request(
      calls.fetch.mock.calls[0]?.[0] ?? "https://unused.example.com",
      calls.fetch.mock.calls[0]?.[1],
    );
    expect(await sent.text()).toBe(form.toString());
    expect(sent.headers.get("cookie")).toBe(requestHeaders.cookie);
    expect(sent.headers.get("x-vercel-trusted-oidc-idp-token")).toBe("private-native-token");
    expect(sent.redirect).toBe("error");
    await expect(
      transport(`${origin}/api/auth/platform/operator-link?callback=https://other.example.com`, {
        method: "POST",
        headers: requestHeaders,
        body: form,
      }),
    ).rejects.toThrow("resource_mismatch");
    expect(calls.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps the private proof credential available when ingress consumes the reserved header", async () => {
    const calls = io();
    const tokens = ["synthetic-private-proof-one", "synthetic-private-proof-two"];
    calls.getOidc.mockResolvedValueOnce(tokens[0]).mockResolvedValueOnce(tokens[1]);
    let received = 0;
    calls.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const expectedToken = tokens[received];
      received += 1;
      expect(request.headers.get("x-vercel-trusted-oidc-idp-token")).toBe(expectedToken);
      // Simulate native ingress consuming its reserved carrier before the private receiver.
      const receiverHeaders = new Headers(request.headers);
      receiverHeaders.delete("x-vercel-trusted-oidc-idp-token");
      expect(receiverHeaders.get("authorization")).toBe(`Bearer ${expectedToken}`);
      expect(receiverHeaders.get("cookie")).toBe(requestHeaders.cookie);
      expect(receiverHeaders.get("origin")).toBe(origin);
      expect(receiverHeaders.get("accept")).toBe("application/vnd.realm-operator-proof+json");
      expect(await request.text()).toBe("nonce=synthetic-proof-nonce");
      return Response.json({ privateProofAccepted: true });
    });
    const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
    const privateRequest = () =>
      new Request(`${origin}/api/auth/platform/operator-link`, {
        method: "POST",
        headers: {
          ...requestHeaders,
          accept: "application/vnd.realm-operator-proof+json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ nonce: "synthetic-proof-nonce" }),
      });
    const first = await transport(privateRequest());
    await expect(first.json()).resolves.toEqual({ privateProofAccepted: true });
    const second = await transport(privateRequest());
    await expect(second.json()).resolves.toEqual({ privateProofAccepted: true });
    expect(calls.getOidc).toHaveBeenCalledTimes(2);
    for (const token of tokens) {
      expect(calls.verifyOidc).toHaveBeenCalledWith(
        token,
        configuration.nativeNeon.configuration.operator,
      );
    }
  });

  it.each([
    ["POST", "/api/auth/sign-up/email", "application/json"],
    ["POST", "/api/auth/sign-in/email", "application/json"],
    ["POST", "/api/auth/platform/operator-link", "application/json"],
    [
      "GET",
      "/api/auth/get-session?disableRefresh=true&disableCookieCache=true",
      "application/vnd.realm-operator-proof+json",
    ],
    ["POST", "/api/auth/sign-in/email", "application/vnd.realm-operator-proof+json"],
    [
      "POST",
      "/api/auth/platform/operator-link",
      "application/vnd.realm-operator-proof+json, application/json",
    ],
  ])(
    "preserves ordinary session transport without bearer authority (%s %s, %s)",
    async (method, route, accept) => {
      const calls = io();
      const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
      await transport(`${origin}${route}`, { method, headers: { ...requestHeaders, accept } });
      const sent = new Headers(calls.fetch.mock.calls[0]?.[1]?.headers);
      expect(sent.has("authorization")).toBe(false);
      expect(sent.get("cookie")).toBe(requestHeaders.cookie);
      expect(sent.get("x-vercel-trusted-oidc-idp-token")).toBe("private-native-token");
    },
  );

  it.each([
    { name: "authorization", value: "Bearer unapproved-caller-token" },
    { name: "x-vercel-trusted-oidc-idp-token", value: "unapproved-caller-token" },
    { name: "origin", value: "https://other.example.com" },
  ])(
    "rejects caller authority or origin on the private proof request before acquiring credentials",
    async ({ name, value }) => {
      const calls = io();
      const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
      await expect(
        transport(`${origin}/api/auth/platform/operator-link`, {
          method: "POST",
          headers: {
            ...requestHeaders,
            accept: "application/vnd.realm-operator-proof+json",
            [name]: value,
          },
        }),
      ).rejects.toThrow("resource_mismatch");
      expect(calls.getOidc).not.toHaveBeenCalled();
      expect(calls.fetch).not.toHaveBeenCalled();
    },
  );

  it("does not send the private proof request when native token verification fails", async () => {
    const calls = io();
    calls.verifyOidc.mockRejectedValueOnce(new Error("native_source_mismatch"));
    const transport = await createHostedOperatorNormalAuthTransport(dependencies(), calls);
    await expect(
      transport(`${origin}/api/auth/platform/operator-link`, {
        method: "POST",
        headers: { ...requestHeaders, accept: "application/vnd.realm-operator-proof+json" },
      }),
    ).rejects.toThrow("native_source_mismatch");
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
