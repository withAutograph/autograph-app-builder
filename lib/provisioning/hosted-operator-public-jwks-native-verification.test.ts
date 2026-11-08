/* oxlint-disable eslint/require-await -- Controlled async token/network/owner ports preserve the real composition signatures. */
import { generateKeyPairSync } from "node:crypto";
import https from "node:https";
import http from "node:http";
import type { ClientRequest } from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readManagedRuntimePublicProfile } from "../sandbox/managed-runtime-capabilities";
import type { createHostedOperatorPublicJwksReader as PublicJwksReaderFactory } from "./hosted-operator-realm-http-transport";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { HostedOperatorContext } from "./hosted-operator-service";

let createHostedOperatorPublicJwksReader: typeof PublicJwksReaderFactory;

const origin = "https://gateway.example";
const operator = {
  audience: "https://vercel.com/team",
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "operator-project",
  environment: "preview" as const,
};
// SAFETY: This callback consumes only the target, Gateway and native-workload fields provided here.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- The unrelated provider configuration is not reached by this real transport composition.
const configuration = {
  applications: { orchard: { projectId: "app-project", branch: "review" } },
  gateway: { publicOrigin: origin, gatewayOrigin: origin },
  operator: { projectId: operator.projectId, environment: operator.environment },
  teamId: "team",
  nativeNeon: { configuration: { operator } },
} as unknown as HostedOperatorSourceConfiguration;
const authority = {
  issuer: "https://builder.example/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context: HostedOperatorContext = {
  authority,
  ownerContext: {
    kind: "direct",
    adapterGeneration: 1,
    adapterSessionId: "native-adapter",
    authority,
    principal: { ...authority, scopes: ["autograph:get"] },
    sessionId: "session",
  },
  target: {
    appId: "orchard",
    branch: "review",
    environment: "preview",
    installationId: "installation",
    projectId: "app-project",
    scopeId: "team",
    scopeType: "team",
    sessionId: "session",
  },
};
const issuer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const foreignSigner = generateKeyPairSync("rsa", { modulusLength: 2048 });
const verificationKey = {
  ...issuer.publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "native-issuer-key",
  use: "sig",
};
const gatewayKey = {
  ...generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }),
  alg: "EdDSA",
  kid: "gateway-profile-key",
  use: "sig",
};
const issuerFetch = vi.fn<typeof fetch>(async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://oidc.vercel.com/.well-known/jwks") {
    throw new Error("Unexpected outbound request in native verification fixture");
  }
  return Response.json({ keys: [verificationKey] });
});
const variants = [
  "valid",
  "foreign-project",
  "wrong-environment",
  "foreign-owner",
  "wrong-issuer",
  "wrong-audience",
  "bad-signature",
] as const;
const signedToken = async (variant: (typeof variants)[number]) =>
  await new SignJWT({
    project_id: variant === "foreign-project" ? "builder-project" : operator.projectId,
    environment: variant === "wrong-environment" ? "production" : operator.environment,
    owner_id: variant === "foreign-owner" ? "foreign-team" : operator.ownerId,
  })
    .setProtectedHeader({ alg: "RS256", kid: verificationKey.kid })
    .setIssuer(
      variant === "wrong-issuer" ? "https://oidc.vercel.com/foreign-team" : operator.issuer,
    )
    .setAudience(
      variant === "wrong-audience" ? "https://vercel.com/foreign-team" : operator.audience,
    )
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(variant === "bad-signature" ? foreignSigner.privateKey : issuer.privateKey);

beforeAll(async () => {
  vi.stubGlobal("fetch", issuerFetch);
  vi.spyOn(http, "get").mockImplementation(() => {
    throw new Error("Unexpected HTTP request in native verification fixture");
  });
  // The installed SDK uses Jose 5's Node HTTPS transport, not global fetch.
  vi.spyOn(https, "get").mockImplementation((input) => {
    const url = input instanceof URL ? input.href : input;
    if (url !== "https://oidc.vercel.com/.well-known/jwks") {
      throw new Error("Unexpected HTTPS request in native verification fixture");
    }
    // oxlint-disable-next-line unicorn/prefer-event-target -- Jose Node transport awaits native ClientRequest EventEmitter response events.
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const response = Object.assign(
      Readable.from([Buffer.from(JSON.stringify({ keys: [verificationKey] }))]),
      { statusCode: 200 },
    );
    queueMicrotask(() => {
      request.emit("response", response);
    });
    // SAFETY: Jose consumes only this response/timeout emitter and destroy method from the HTTP request.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Only the native network boundary is replaced; signature/claim verification remains the installed SDK.
    return request as unknown as ClientRequest;
  });
  // Install every network boundary before importing the actual SDK-backed callback.
  ({ createHostedOperatorPublicJwksReader } =
    await import("./hosted-operator-realm-http-transport"));
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public profile with the actual native OIDC signature and claim verifier", () => {
  it.each(variants)("verifies %s before any Gateway read", async (variant) => {
    const token = await signedToken(variant);
    const getOidc = vi.fn(async () => token);
    const gatewayFetch = vi.fn<typeof fetch>(async () => Response.json({ keys: [gatewayKey] }));
    const assertPlanningAuthorized = vi.fn<() => Promise<void>>().mockResolvedValue();
    const assertCurrentOwner = vi.fn<() => Promise<void>>().mockResolvedValue();
    // No verifyOidc override: the installed @vercel/oidc SDK and Jose fetch keys and verify this RS256 token.
    const reader = createHostedOperatorPublicJwksReader(
      { configuration, assertPlanningAuthorized, assertCurrentOwner },
      { getOidc, fetch: gatewayFetch },
    );
    const profile = readManagedRuntimePublicProfile({
      appId: "orchard",
      publicOrigin: origin,
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      readPublicJwks: (url) => reader(context, url),
    });
    if (variant === "valid") {
      await expect(profile).resolves.toMatchObject({
        appId: "orchard",
        jwksUrl: `${origin}/_platform/jwks.json`,
        keys: [gatewayKey],
        publicOrigin: origin,
      });
      expect(https.get).toHaveBeenCalled();
      expect(gatewayFetch).toHaveBeenCalledTimes(1);
      const [address, init] = gatewayFetch.mock.calls[0] ?? [];
      expect(address instanceof URL && address.href).toBe(`${origin}/_platform/jwks.json`);
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe(token);
      expect(headers.has("cookie")).toBe(false);
      expect(assertCurrentOwner).toHaveBeenCalledTimes(2);
    } else {
      const expected = {
        "bad-signature": /signature verification failed/u,
        "foreign-owner": /owner_id/u,
        "foreign-project": /project_id/u,
        "wrong-audience": /aud/u,
        "wrong-environment": /environment/u,
        "wrong-issuer": /iss/u,
      }[variant];
      await expect(profile).rejects.toThrow(expected);
      expect(gatewayFetch).not.toHaveBeenCalled();
    }
    expect(getOidc).toHaveBeenCalledWith({ project: operator.projectId, team: operator.ownerId });
    expect(assertPlanningAuthorized).toHaveBeenCalledWith(context);
  });
});
