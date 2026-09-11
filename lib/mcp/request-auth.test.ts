import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  createRemoteJwksAccessTokenVerifier,
  hostedMcpAuthConfigSchema,
  parseStrictBearerAuthorization,
  protectedResourceMetadata,
} from "./request-auth";

const config = hostedMcpAuthConfigSchema.parse({
  algorithm: "ES256",
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  jwksUrl: "https://builder.example.test/api/auth/jwks",
  resourceUrl: "https://builder.example.test/mcp",
});

describe("hosted MCP request authentication", () => {
  it("accepts only one strict RFC 6750 Bearer value", () => {
    expect(parseStrictBearerAuthorization("Bearer abc.DEF_-/~+==")).toBe(
      "abc.DEF_-/~+=="
    );
    for (const value of [
      null,
      "Basic abc",
      "Bearer",
      "Bearer  abc",
      "Bearer\tabc",
      "Bearer abc, Bearer def",
      "Bearer ab=c",
      "Bearer abc def",
    ]) {
      expect(() => parseStrictBearerAuthorization(value)).toThrow();
    }
  });

  it("rejects weak or ambiguous hosted authentication configuration", () => {
    expect(() =>
      hostedMcpAuthConfigSchema.parse({
        ...config,
        algorithm: "HS256",
      })
    ).toThrow();
    expect(() =>
      hostedMcpAuthConfigSchema.parse({
        ...config,
        jwksUrl: "http://identity.example.test/jwks",
      })
    ).toThrow();
    expect(() =>
      hostedMcpAuthConfigSchema.parse({
        ...config,
        jwksUrl: `${config.jwksUrl}?tenant=one`,
      })
    ).toThrow();
    expect(() =>
      hostedMcpAuthConfigSchema.parse({
        ...config,
        audience: "https://another.example.test/mcp",
      })
    ).toThrow("audience must equal");
  });

  it("publishes closed protected-resource metadata", () => {
    expect(protectedResourceMetadata(config)).toEqual({
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      resource: config.resourceUrl,
      scopes_supported: [
        "autograph:session",
        "autograph:start",
        "autograph:get",
        "autograph:send",
        "autograph:respond",
        "autograph:cancel",
      ],
    });
  });

  it("verifies exact issuer, audience, algorithm, kid, time, scope, and workspace claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "ES256", kid: "key-1" };
    const fetchCalls: [string | URL | Request, RequestInit | undefined][] = [];
    const fetchImplementation: typeof fetch = async (url, options) => {
      fetchCalls.push([url, options]);
      return Response.json({ keys: [jwk] });
    };
    const verifier = createRemoteJwksAccessTokenVerifier({
      config,
      fetchImplementation,
    });
    const now = 2_000_000_000;
    const token = await new SignJWT({
      scope: "autograph:session autograph:get",
      workspace_id: "workspace-one",
    })
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject("user-one")
      .setIssuedAt(now - 1)
      .setNotBefore(now - 1)
      .setExpirationTime(now + 60)
      .sign(privateKey);

    await expect(
      verifier.verify({ nowEpochSeconds: now, token })
    ).resolves.toEqual({
      audience: config.audience,
      issuer: config.issuer,
      scopes: ["autograph:session", "autograph:get"],
      subject: "user-one",
      workspaceId: "workspace-one",
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.[0]).toBe(config.jwksUrl);
    expect(fetchCalls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it.each<
    [
      string,
      Partial<{
        audience: string;
        expirationTime: number;
        issuedAt: number;
        notBefore: number;
        kid: undefined;
      }>,
    ]
  >([
    ["wrong audience", { audience: "another-audience" }],
    ["expired", { expirationTime: 1_999_999_999 }],
    ["long-lived", { expirationTime: 2_000_000_301 }],
    ["future issued-at", { issuedAt: 2_000_000_001 }],
    ["future not-before", { notBefore: 2_000_000_001 }],
    ["missing key id", { kid: undefined }],
  ])("rejects %s", async (_name, override) => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "ES256", kid: "key-1" };
    const verifier = createRemoteJwksAccessTokenVerifier({
      config,
      fetchImplementation: async () => Response.json({ keys: [jwk] }),
    });
    const now = 2_000_000_000;
    const omitKid = Object.hasOwn(override, "kid");
    const signer = new SignJWT({
      scope: "autograph:session",
      workspace_id: "workspace-one",
    })
      .setProtectedHeader({
        alg: "ES256",
        ...(omitKid ? {} : { kid: "key-1" }),
      })
      .setIssuer(config.issuer)
      .setAudience(override.audience ?? config.audience)
      .setSubject("user-one")
      .setIssuedAt(override.issuedAt ?? now - 1)
      .setNotBefore(override.notBefore ?? now - 1)
      .setExpirationTime(override.expirationTime ?? now + 60);
    const token = await signer.sign(privateKey);
    await expect(
      verifier.verify({ nowEpochSeconds: now, token })
    ).rejects.toThrow();
  });

  it("refuses JWKS redirects", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const verifier = createRemoteJwksAccessTokenVerifier({
      config,
      fetchImplementation: async () =>
        new Response(null, {
          headers: { location: "https://other.example.test/jwks" },
          status: 302,
        }),
    });
    const token = await new SignJWT({
      scope: "autograph:session",
      workspace_id: "workspace-one",
    })
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject("user-one")
      .setIssuedAt(1_999_999_999)
      .setNotBefore(1_999_999_999)
      .setExpirationTime(2_000_000_060)
      .sign(privateKey);
    await expect(
      verifier.verify({ nowEpochSeconds: 2_000_000_000, token })
    ).rejects.toThrow("redirects");
  });
});
