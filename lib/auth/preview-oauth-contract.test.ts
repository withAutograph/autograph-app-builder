import { describe, expect, it, vi } from "vitest";

import {
  buildPreviewCimdOptions,
  buildPreviewMcpOAuthOptions,
  previewEmailPasswordPolicy,
  previewOAuthScopes,
  readPreviewOAuthContractConfig,
} from "./preview-oauth-contract";

const config = {
  issuer: "https://builder.example.test/api/auth",
  resource: "https://builder.example.test/mcp",
};

function membership(active = true) {
  return {
    activeWorkspaceForUser: vi.fn(async () =>
      active ? "workspace_1" : undefined,
    ),
    isActiveMember: vi.fn(async () => active),
  };
}

describe("Preview OAuth activation contract", () => {
  it("closes issuer and resource to one exact origin and route", () => {
    expect(
      readPreviewOAuthContractConfig({
        BETTER_AUTH_URL: config.issuer,
        MCP_RESOURCE_URL: config.resource,
      }),
    ).toEqual(config);
    for (const candidate of [
      { ...config, issuer: "https://other.example.test/api/auth" },
      { ...config, issuer: "https://builder.example.test/not-auth" },
      { ...config, resource: "https://builder.example.test/not-mcp" },
      { ...config, resource: `${config.resource}?tenant=one` },
    ]) {
      expect(() =>
        buildPreviewMcpOAuthOptions({
          config: candidate,
          membership: membership(),
        }),
      ).toThrow();
    }
  });

  it("declares only approval-bound user grants, S256 policy, and server-owned ceilings", async () => {
    const options = buildPreviewMcpOAuthOptions({
      config,
      membership: membership(),
    });
    expect(options).toMatchObject({
      resource: config.resource,
      loginPage: "/auth/sign-in",
      consentPage: "/auth/consent",
      grantTypes: ["authorization_code", "refresh_token"],
      accessTokenExpiresIn: 300,
      refreshTokenExpiresIn: 28_800,
      clientRegistrationRequirePKCE: true,
      allowPublicClientPrelogin: true,
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      clientRegistrationDefaultResources: [config.resource],
      clientRegistrationAllowedResources: [],
      clientRegistrationDefaultScopes: ["autograph:session", "offline_access"],
    });
    expect(options.scopes).toEqual(previewOAuthScopes);
    expect(options.clientRegistrationAllowedScopes).toEqual(
      previewOAuthScopes.slice(1),
    );
    expect(options.resources).toEqual([
      {
        identifier: config.resource,
        accessTokenTtl: 300,
        refreshTokenTtl: 28_800,
        allowedScopes: [...previewOAuthScopes],
        signingAlgorithm: "ES256",
      },
    ]);
    expect(previewEmailPasswordPolicy).toEqual({
      enabled: false,
    });
    for (const action of [
      "create",
      "read",
      "update",
      "delete",
      "list",
      "rotate",
      "configure-client-credentials-scopes",
    ] as const) {
      await expect(
        options.clientPrivileges?.({
          headers: new Headers(),
          action,
        }),
      ).resolves.toBe(false);
    }
    for (const action of [
      "create",
      "read",
      "update",
      "delete",
      "list",
      "link",
      "unlink",
    ] as const) {
      await expect(
        options.resourcePrivileges?.({
          headers: new Headers(),
          action,
        }),
      ).resolves.toBe(false);
    }
  });

  it("binds consent and token claims to the same live exact membership", async () => {
    const authority = membership();
    const options = buildPreviewMcpOAuthOptions({
      config,
      membership: authority,
      now: () => 2_000_000_000_000,
    });
    const user = { id: "user_1" } as never;
    await expect(
      options.postLogin?.shouldRedirect({
        headers: new Headers(),
        user,
        session: {} as never,
        scopes: ["autograph:session"],
      }),
    ).resolves.toBe(false);
    await expect(
      options.postLogin?.consentReferenceId({
        user,
        session: {} as never,
        scopes: ["autograph:session"],
      }),
    ).resolves.toBe("workspace_1");
    await expect(
      options.customAccessTokenClaims?.({
        user,
        referenceId: "workspace_1",
        scopes: ["autograph:session"],
        resources: [config.resource],
      }),
    ).resolves.toEqual({
      nbf: 2_000_000_000,
      workspace_id: "workspace_1",
    });
    expect(authority.isActiveMember).toHaveBeenCalledWith({
      issuer: config.issuer,
      audience: config.resource,
      workspaceId: "workspace_1",
      ownerUserId: "user_1",
    });
  });

  it("fails claim issuance closed for absent membership or wrong resource", async () => {
    const inactive = buildPreviewMcpOAuthOptions({
      config,
      membership: membership(false),
    });
    const user = { id: "user_1" } as never;
    await expect(
      inactive.postLogin?.shouldRedirect({
        headers: new Headers(),
        user,
        session: {} as never,
        scopes: ["autograph:session"],
      }),
    ).rejects.toThrow("exactly one active");
    await expect(
      inactive.postLogin?.consentReferenceId({
        user,
        session: {} as never,
        scopes: ["autograph:session"],
      }),
    ).rejects.toThrow("exactly one active");
    await expect(
      inactive.customAccessTokenClaims?.({
        user,
        referenceId: "workspace_1",
        scopes: ["autograph:session"],
        resources: [config.resource],
      }),
    ).rejects.toThrow("not active");

    const active = buildPreviewMcpOAuthOptions({
      config,
      membership: membership(),
    });
    await expect(
      active.customAccessTokenClaims?.({
        user,
        referenceId: "workspace_1",
        scopes: ["autograph:session"],
        resources: ["https://other.example.test/mcp"],
      }),
    ).rejects.toThrow("not active");
  });

  it("pins CIMD to public clients through the application-owned transport", async () => {
    const fetchClientMetadataResource = vi.fn(async () =>
      Response.json({
        client_name: "Codex",
        redirect_uris: ["http://127.0.0.1:43123/auth/callback"],
        token_endpoint_auth_method: "none",
      }),
    );
    const options = buildPreviewCimdOptions({ fetchClientMetadataResource });
    expect(options.metadataProfile).toBe("mcp-2026-07-28");
    const response = await options.fetchClientMetadataResource(
      "https://client.example/codex.json",
    );
    await expect(response.json()).resolves.toMatchObject({
      token_endpoint_auth_method: "none",
    });
  });

  it("preserves the native Codex refresh capability", async () => {
    const fetchClientMetadataResource = vi.fn(async () =>
      Response.json({
        client_id: "https://chatgpt.com/oauth/codex/4-bzS8rt42zJ/client.json",
        client_uri: "https://chatgpt.com/codex",
        application_type: "native",
        redirect_uris: [
          "http://127.0.0.1/callback/4-bzS8rt42zJ",
          "http://localhost/callback/4-bzS8rt42zJ",
        ],
        token_endpoint_auth_method: "none",
        token_endpoint_auth_methods_supported: ["none"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Codex",
        logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
      }),
    );
    const options = buildPreviewCimdOptions({ fetchClientMetadataResource });
    const response = await options.fetchClientMetadataResource(
      "https://chatgpt.com/oauth/codex/4-bzS8rt42zJ/client.json",
    );

    await expect(response.json()).resolves.toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [
        "http://127.0.0.1/callback/4-bzS8rt42zJ",
        "http://localhost/callback/4-bzS8rt42zJ",
      ],
    });

    const unsupported = buildPreviewCimdOptions({
      fetchClientMetadataResource: vi.fn(async () =>
        Response.json({
          client_name: "Expanded client",
          redirect_uris: ["http://127.0.0.1/callback"],
          token_endpoint_auth_method: "none",
          grant_types: [
            "authorization_code",
            "refresh_token",
            "client_credentials",
          ],
          response_types: ["code"],
        }),
      ),
    });
    const unsupportedResponse = await unsupported.fetchClientMetadataResource(
      "https://client.example/expanded.json",
    );
    await expect(unsupportedResponse.json()).resolves.toMatchObject({
      grant_types: [
        "authorization_code",
        "refresh_token",
        "client_credentials",
      ],
    });
  });

  it("rejects missing and private_key_jwt auth before CIMD persistence", async () => {
    for (const tokenEndpointAuthMethod of [undefined, "private_key_jwt"]) {
      const options = buildPreviewCimdOptions({
        fetchClientMetadataResource: vi.fn(async () =>
          Response.json({
            client_name: "Privileged client",
            redirect_uris: ["https://client.example/callback"],
            ...(tokenEndpointAuthMethod === undefined
              ? {}
              : { token_endpoint_auth_method: tokenEndpointAuthMethod }),
          }),
        ),
      });
      await expect(
        options.fetchClientMetadataResource(
          "https://client.example/metadata.json",
        ),
      ).rejects.toThrow("token_endpoint_auth_method none");
    }
  });
});
