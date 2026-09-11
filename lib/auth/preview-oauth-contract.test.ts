import { describe, expect, it, vi } from "vitest";

import {
  buildPreviewCimdOptions,
  buildPreviewMcpOAuthOptions,
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
      active ? "workspace_1" : undefined
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
      })
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
        })
      ).toThrow();
    }
  });

  it("declares only approval-bound user grants, S256 policy, and server-owned ceilings", async () => {
    const options = buildPreviewMcpOAuthOptions({
      config,
      membership: membership(),
    });
    expect(options).toMatchObject({
      accessTokenExpiresIn: 300,
      allowDynamicClientRegistration: false,
      allowPublicClientPrelogin: true,
      allowUnauthenticatedClientRegistration: false,
      clientRegistrationAllowedResources: [],
      clientRegistrationDefaultResources: [config.resource],
      clientRegistrationDefaultScopes: ["autograph:session", "offline_access"],
      clientRegistrationRequirePKCE: true,
      consentPage: "/auth/consent",
      grantTypes: ["authorization_code", "refresh_token"],
      loginPage: "/auth/sign-in",
      refreshTokenExpiresIn: 28_800,
      resource: config.resource,
    });
    expect(options.scopes).toEqual(previewOAuthScopes);
    expect(options.clientRegistrationAllowedScopes).toEqual(
      previewOAuthScopes.slice(1)
    );
    expect(options.resources).toEqual([
      {
        accessTokenTtl: 300,
        allowedScopes: [...previewOAuthScopes],
        identifier: config.resource,
        refreshTokenTtl: 28_800,
        signingAlgorithm: "ES256",
      },
    ]);
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
          action,
          headers: new Headers(),
        })
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
          action,
          headers: new Headers(),
        })
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
        scopes: ["autograph:session"],
        session: {} as never,
        user,
      })
    ).resolves.toBe(false);
    await expect(
      options.postLogin?.consentReferenceId({
        scopes: ["autograph:session"],
        session: {} as never,
        user,
      })
    ).resolves.toBe("workspace_1");
    await expect(
      options.customAccessTokenClaims?.({
        referenceId: "workspace_1",
        resources: [config.resource],
        scopes: ["autograph:session"],
        user,
      })
    ).resolves.toEqual({
      nbf: 2_000_000_000,
      workspace_id: "workspace_1",
    });
    expect(authority.isActiveMember).toHaveBeenCalledWith({
      audience: config.resource,
      issuer: config.issuer,
      ownerUserId: "user_1",
      workspaceId: "workspace_1",
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
        scopes: ["autograph:session"],
        session: {} as never,
        user,
      })
    ).rejects.toThrow("exactly one active");
    await expect(
      inactive.postLogin?.consentReferenceId({
        scopes: ["autograph:session"],
        session: {} as never,
        user,
      })
    ).rejects.toThrow("exactly one active");
    await expect(
      inactive.customAccessTokenClaims?.({
        referenceId: "workspace_1",
        resources: [config.resource],
        scopes: ["autograph:session"],
        user,
      })
    ).rejects.toThrow("not active");

    const active = buildPreviewMcpOAuthOptions({
      config,
      membership: membership(),
    });
    await expect(
      active.customAccessTokenClaims?.({
        referenceId: "workspace_1",
        resources: ["https://other.example.test/mcp"],
        scopes: ["autograph:session"],
        user,
      })
    ).rejects.toThrow("not active");
  });

  it("pins CIMD to public clients through the application-owned transport", async () => {
    const fetchClientMetadataResource = vi.fn(async () =>
      Response.json({
        client_name: "Codex",
        redirect_uris: ["http://127.0.0.1:43123/auth/callback"],
        token_endpoint_auth_method: "none",
      })
    );
    const options = buildPreviewCimdOptions({ fetchClientMetadataResource });
    expect(options.metadataProfile).toBe("mcp-2026-07-28");
    const response = await options.fetchClientMetadataResource(
      "https://client.example/codex.json"
    );
    await expect(response.json()).resolves.toMatchObject({
      token_endpoint_auth_method: "none",
    });
  });

  it("preserves the native Codex refresh capability", async () => {
    const fetchClientMetadataResource = vi.fn(async () =>
      Response.json({
        application_type: "native",
        client_id: "https://chatgpt.com/oauth/codex/4-bzS8rt42zJ/client.json",
        client_name: "Codex",
        client_uri: "https://chatgpt.com/codex",
        grant_types: ["authorization_code", "refresh_token"],
        logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
        redirect_uris: [
          "http://127.0.0.1/callback/4-bzS8rt42zJ",
          "http://localhost/callback/4-bzS8rt42zJ",
        ],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        token_endpoint_auth_methods_supported: ["none"],
      })
    );
    const options = buildPreviewCimdOptions({ fetchClientMetadataResource });
    const response = await options.fetchClientMetadataResource(
      "https://chatgpt.com/oauth/codex/4-bzS8rt42zJ/client.json"
    );

    await expect(response.json()).resolves.toMatchObject({
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [
        "http://127.0.0.1/callback/4-bzS8rt42zJ",
        "http://localhost/callback/4-bzS8rt42zJ",
      ],
      token_endpoint_auth_method: "none",
    });

    const unsupported = buildPreviewCimdOptions({
      fetchClientMetadataResource: vi.fn(async () =>
        Response.json({
          client_name: "Expanded client",
          grant_types: [
            "authorization_code",
            "refresh_token",
            "client_credentials",
          ],
          redirect_uris: ["http://127.0.0.1/callback"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        })
      ),
    });
    const unsupportedResponse = await unsupported.fetchClientMetadataResource(
      "https://client.example/expanded.json"
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
          })
        ),
      });
      await expect(
        options.fetchClientMetadataResource(
          "https://client.example/metadata.json"
        )
      ).rejects.toThrow("token_endpoint_auth_method none");
    }
  });
});
