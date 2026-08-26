import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  createRemoteJwksAccessTokenVerifier,
  hostedMcpAuthConfigSchema,
  parseStrictBearerAuthorization,
  protectedResourceMetadata,
} from "./request-auth";

const config = hostedMcpAuthConfigSchema.parse({
  issuer: "https://identity.example.test",
  audience: "eve-hosted",
  jwksUrl: "https://identity.example.test/.well-known/jwks.json",
  algorithm: "ES256",
  resourceUrl: "https://builder.example.test/mcp",
});

describe("hosted MCP request authentication", () => {
  it("accepts only one strict RFC 6750 Bearer value", () => {
    expect(parseStrictBearerAuthorization("Bearer abc.DEF_-/~+==")).toBe(
      "abc.DEF_-/~+==",
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
      }),
    ).toThrow();
    expect(() =>
      hostedMcpAuthConfigSchema.parse({
        ...config,
        jwksUrl: "http://identity.example.test/jwks",
      }),
    ).toThrow();
    expect(() =>
      hostedMcpAuthConfigSchema.parse({
        ...config,
        jwksUrl: `${config.jwksUrl}?tenant=one`,
      }),
    ).toThrow();
  });

  it("publishes closed protected-resource metadata", () => {
    expect(protectedResourceMetadata(config)).toEqual({
      resource: config.resourceUrl,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [
        "eve:session",
        "eve:start",
        "eve:get",
        "eve:send",
        "eve:respond",
        "eve:cancel",
      ],
    });
  });

  it("verifies exact issuer, audience, algorithm, kid, time, scope, and workspace claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "ES256" };
    const fetchCalls: Array<[string | URL | Request, RequestInit | undefined]> =
      [];
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
      scope: "eve:session eve:get",
      workspace_id: "workspace-one",
    })
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject("user-one")
      .setNotBefore(now - 1)
      .setExpirationTime(now + 60)
      .sign(privateKey);

    await expect(
      verifier.verify({ token, nowEpochSeconds: now }),
    ).resolves.toEqual({
      issuer: config.issuer,
      audience: config.audience,
      subject: "user-one",
      workspaceId: "workspace-one",
      scopes: ["eve:session", "eve:get"],
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
        notBefore: number;
        kid: undefined;
      }>,
    ]
  >([
    ["wrong audience", { audience: "another-audience" }],
    ["expired", { expirationTime: 1_999_999_999 }],
    ["future not-before", { notBefore: 2_000_000_001 }],
    ["missing key id", { kid: undefined }],
  ])("rejects %s", async (_name, override) => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "ES256" };
    const verifier = createRemoteJwksAccessTokenVerifier({
      config,
      fetchImplementation: async () => Response.json({ keys: [jwk] }),
    });
    const now = 2_000_000_000;
    const omitKid = Object.hasOwn(override, "kid");
    const signer = new SignJWT({
      scope: "eve:session",
      workspace_id: "workspace-one",
    })
      .setProtectedHeader({
        alg: "ES256",
        ...(omitKid ? {} : { kid: "key-1" }),
      })
      .setIssuer(config.issuer)
      .setAudience(override.audience ?? config.audience)
      .setSubject("user-one")
      .setNotBefore(override.notBefore ?? now - 1)
      .setExpirationTime(override.expirationTime ?? now + 60);
    const token = await signer.sign(privateKey);
    await expect(
      verifier.verify({ token, nowEpochSeconds: now }),
    ).rejects.toThrow();
  });

  it("refuses JWKS redirects", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const verifier = createRemoteJwksAccessTokenVerifier({
      config,
      fetchImplementation: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example.test/jwks" },
        }),
    });
    const token = await new SignJWT({
      scope: "eve:session",
      workspace_id: "workspace-one",
    })
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject("user-one")
      .setNotBefore(1_999_999_999)
      .setExpirationTime(2_000_000_060)
      .sign(privateKey);
    await expect(
      verifier.verify({ token, nowEpochSeconds: 2_000_000_000 }),
    ).rejects.toThrow("redirects");
  });
});
