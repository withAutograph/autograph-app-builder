import type { HostedOperatorConsentDiagnosticSink } from "./hosted-operator-consent-diagnostic";
import { HostedOperatorError } from "./hosted-operator-contract";
/* oxlint-disable eslint/require-await -- Injected SDK fixture methods intentionally preserve Promise contracts. */
import { describe, expect, it, vi } from "vitest";
import { UserAuthorizationRequiredError } from "@vercel/connect";
import type { ConnectAuthorizationResponse, startAuthorization } from "@vercel/connect";
import {
  createHostedOperatorNeonAuthorization,
  readNeonAuthorizationConfiguration,
} from "./hosted-operator-neon-authorization";
import type { HostedOperatorConsentOwner } from "./hosted-operator-consent-owner";

const configuration = {
  builderCallbackOrigin: "https://builder.example",
  builderWorkload: {
    audience: "https://vercel.com/team",
    environment: "production" as const,
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team",
    projectId: "builder",
    subject: "builder-subject",
  },
  operatorWorkload: {
    audience: "https://vercel.com/team",
    environment: "preview" as const,
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team",
    projectId: "operator",
  },
};
const context: HostedOperatorConsentOwner = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "canonical-owner",
    workspaceId: "workspace",
  },
  ownerContext: {
    adapterGeneration: 1,
    adapterSessionId: "adapter-session",
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "canonical-owner",
      workspaceId: "workspace",
    },
    kind: "direct",
    principal: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "canonical-owner",
      scopes: ["builder:read"],
      workspaceId: "workspace",
    },
    sessionId: "original-session",
  },
};
const fixture = () => {
  const diagnosticSink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  const assertCurrentOwner = vi.fn(async () => {});
  const io = {
    getOidc: vi.fn(async () => "private-operator-oidc"),
    getTokenResponse: vi.fn(async () => ({
      connector: { id: "connector-id", type: "oauth", uid: "mcp.neon.tech/neon-preview-operator" },
      expiresAt: Date.now() + 60_000,
      token: "private-provider-token",
    })),
    startAuthorization: vi.fn<typeof startAuthorization>(async () => ({
      expiresAt: Date.now() + 60_000,
      request: "private-request",
      url: "https://vercel.com/connect/authorize?request=opaque",
      verifier: "private-verifier",
    })),
    verifyOidc: vi.fn(async () => {}),
  };
  return {
    assertCurrentOwner,
    diagnosticSink,
    io,
    run: createHostedOperatorNeonAuthorization(
      { assertCurrentOwner, configuration, diagnosticSink },
      io,
    ),
  };
};
describe("canonical owner Neon consent", () => {
  it("loads narrow consent setup without app/image/branch/full runtime configuration", () => {
    expect(
      readNeonAuthorizationConfiguration({
        PROTECTED_HOSTED_OPERATOR_AUTHORIZATION_CONFIGURATION: JSON.stringify(configuration),
      }),
    ).toEqual(configuration);
  });
  it("starts fixed scoped owner consent under verified operator OIDC and projects only the challenge", async () => {
    const f = fixture();
    const result = await f.run(context, {
      callbackUrl: "https://builder.example/_workflow/callback/opaque",
      phase: "start",
    });
    expect(f.io.verifyOidc).toHaveBeenCalledWith(
      "private-operator-oidc",
      configuration.operatorWorkload,
    );
    expect(f.io.startAuthorization).toHaveBeenCalledWith(
      "mcp.neon.tech/neon-preview-operator",
      {
        resources: ["https://mcp.neon.tech/mcp"],
        scopes: ["read", "write"],
        subject: { id: "canonical-owner", issuer: context.authority.issuer, type: "user" },
      },
      {
        callbackUrl: "https://builder.example/_workflow/callback/opaque",
        deviceCode: true,
        vercelToken: "private-operator-oidc",
        webhook: "https://builder.example/_workflow/callback/opaque",
      },
    );
    expect(f.assertCurrentOwner).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      challenge: { displayName: "Connect Neon" },
      status: "authorization-started",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-request|private-verifier|private-operator-oidc/u,
    );
    expect(f.io.getTokenResponse).not.toHaveBeenCalled();
  });
  it.each(["check", "complete"] as const)(
    "revalidates %s and discards the private provider credential",
    async (phase) => {
      const f = fixture();
      const result = await f.run(context, { phase });
      expect(result).toMatchObject({ status: "ready" });
      expect(JSON.stringify(result)).not.toContain("private-provider-token");
      expect(f.io.getTokenResponse).toHaveBeenCalledWith(
        "mcp.neon.tech/neon-preview-operator",
        expect.objectContaining({
          subject: { id: "canonical-owner", issuer: context.authority.issuer, type: "user" },
        }),
        { forceRefresh: true, vercelToken: "private-operator-oidc" },
      );
      expect(f.assertCurrentOwner).toHaveBeenCalledTimes(3);
    },
  );
  it("reports missing grant without treating it as completed authorization", async () => {
    const f = fixture();
    f.io.getTokenResponse.mockRejectedValue(
      new UserAuthorizationRequiredError("owner consent required"),
    );
    await expect(f.run(context, { phase: "check" })).resolves.toEqual({
      status: "authorization-required",
    });
  });
  it("does not contact Connect after owner membership or generation is rejected", async () => {
    const f = fixture();
    f.assertCurrentOwner.mockRejectedValue(new Error("owner revoked"));
    await expect(
      f.run(context, { callbackUrl: "https://builder.example/callback", phase: "start" }),
    ).rejects.toThrow("owner revoked");
    expect(f.io.startAuthorization).not.toHaveBeenCalled();
    expect(f.io.getOidc).not.toHaveBeenCalled();
  });
  it("does not publish a challenge after the owner becomes stale during authorization", async () => {
    const f = fixture();
    f.assertCurrentOwner
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("generation changed"));
    await expect(
      f.run(context, { callbackUrl: "https://builder.example/callback", phase: "start" }),
    ).rejects.toThrow("generation changed");
  });
  it("rejects a foreign callback before starting provider consent", async () => {
    const f = fixture();
    await expect(
      f.run(context, { callbackUrl: "https://foreign.example/callback", phase: "start" }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.io.startAuthorization).not.toHaveBeenCalled();
  });
  it("accepts the fixed connector's SDK-returned HTTPS provider URL without publishing private fields", async () => {
    const f = fixture();
    f.io.startAuthorization.mockResolvedValue({
      expiresAt: Date.now() + 60_000,
      request: "private-request",
      url: "https://console.neon.tech/oauth/authorize?public-challenge=opaque",
      verifier: "private-verifier",
    });
    const result = await f.run(context, {
      callbackUrl: "https://builder.example/callback",
      phase: "start",
    });
    expect(result).toMatchObject({
      challenge: { url: "https://console.neon.tech/oauth/authorize?public-challenge=opaque" },
      status: "authorization-started",
    });
    expect(JSON.stringify(result)).not.toMatch(/private-request|private-verifier/u);
    expect(JSON.stringify(f.diagnosticSink.mock.calls)).not.toMatch(/console.neon.tech|private/u);
  });
});

// The pinned SDK returns unchecked response.json(); these fixtures exercise that runtime boundary.
interface UncheckedAuthorizationResponse {
  deviceCode?: unknown;
  expiresAt?: unknown;
  request: string;
  url?: unknown;
  verifier: string;
}
const sdkResponse = (
  fields: Pick<UncheckedAuthorizationResponse, "url" | "deviceCode" | "expiresAt">,
): ConnectAuthorizationResponse =>
  // SAFETY: Local fault fixtures deliberately model the SDK's unchecked JSON; injected IO prevents any provider call.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Invalid SDK JSON must reach the owned runtime validation boundary.
  ({
    request: "private-request",
    url: "https://console.neon.tech/oauth/authorize?public-challenge=opaque",
    verifier: "private-verifier",
    ...fields,
  }) as ConnectAuthorizationResponse;

describe("native SDK challenge projection", () => {
  it.each([null, ""])("omits optional empty device code %j", async (deviceCode) => {
    const f = fixture();
    f.io.startAuthorization.mockResolvedValue(sdkResponse({ deviceCode }));
    const result = await f.run(context, {
      callbackUrl: "https://builder.example/callback",
      phase: "start",
    });
    expect(result).toMatchObject({ status: "authorization-started" });
    expect(result).not.toHaveProperty("challenge.userCode");
    expect(JSON.stringify(f.diagnosticSink.mock.calls)).not.toContain("private");
  });
  it("retains a public device code and projects milliseconds without adding an expiry gate", async () => {
    const f = fixture();
    f.io.startAuthorization.mockResolvedValue(
      sdkResponse({ deviceCode: "PUBLIC-CODE", expiresAt: 0 }),
    );
    await expect(
      f.run(context, { callbackUrl: "https://builder.example/callback", phase: "start" }),
    ).resolves.toEqual({
      challenge: {
        displayName: "Connect Neon",
        expiresAt: "1970-01-01T00:00:00.000Z",
        url: "https://console.neon.tech/oauth/authorize?public-challenge=opaque",
        userCode: "PUBLIC-CODE",
      },
      status: "authorization-started",
    });
    expect(JSON.stringify(f.diagnosticSink.mock.calls)).not.toContain("PUBLIC-CODE");
  });
  it.each([
    // oxlint-disable-next-line sonarjs/no-clear-text-protocols -- Rejected HTTP challenge fixture, never requested.
    [{ url: "http://console.neon.tech/consent" }, "url_invalid"],
    [{ url: "https://user:private@console.neon.tech/consent" }, "url_invalid"],
    [{ url: "not-a-url-private" }, "url_invalid"],
    [{ url: null }, "url_missing"],
    [{ deviceCode: 123 }, "device_code_invalid"],
    [{ deviceCode: { private: "code" } }, "device_code_invalid"],
    [{ expiresAt: null }, "expiry_invalid"],
    [{ expiresAt: "private-expiry" }, "expiry_invalid"],
    [{ expiresAt: Number.NaN }, "expiry_invalid"],
    [{ expiresAt: Number.POSITIVE_INFINITY }, "expiry_invalid"],
    [{ expiresAt: 1e20 }, "expiry_invalid"],
  ] as const)(
    "rejects malformed SDK fields with only closed failure %s",
    async (fields, failure) => {
      const f = fixture();
      f.io.startAuthorization.mockResolvedValue(sdkResponse(fields));
      await expect(
        f.run(context, { callbackUrl: "https://builder.example/callback", phase: "start" }),
      ).rejects.toMatchObject({ code: "operator_unavailable" });
      expect(f.assertCurrentOwner).toHaveBeenCalledTimes(3);
      expect(
        f.diagnosticSink.mock.calls.map(([entry]) => [
          entry.stage,
          entry.outcome,
          entry.challengeProjection?.failure,
        ]),
      ).toContainEqual(["provider_start_projection", "setup_unavailable", failure]);
      expect(JSON.stringify(f.diagnosticSink.mock.calls)).not.toMatch(/private|console.neon.tech/u);
    },
  );
  it("reports a malformed root response and hostile getters without logging SDK contents", async () => {
    for (const response of [
      null,
      Object.defineProperty({ request: "private", verifier: "private" }, "url", {
        get() {
          throw new Error("private-response");
        },
      }),
    ]) {
      const f = fixture();
      // SAFETY: Both inputs are synthetic unchecked SDK responses; no actual SDK or provider is invoked.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise malformed response and hostile getter rejection.
      f.io.startAuthorization.mockResolvedValue(response as ConnectAuthorizationResponse);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Isolate each malformed SDK response and its private diagnostic sink.
      await expect(
        f.run(context, { callbackUrl: "https://builder.example/callback", phase: "start" }),
      ).rejects.toMatchObject({ code: "operator_unavailable" });
      expect(
        f.diagnosticSink.mock.calls.map(([entry]) => entry.challengeProjection?.failure),
      ).toContain("response_invalid");
      expect(JSON.stringify(f.diagnosticSink.mock.calls)).not.toContain("private");
    }
  });
  it("rechecks the owner before accessing a returned challenge", async () => {
    const f = fixture();
    const readChallenge = vi.fn(() => "https://console.neon.tech/consent");
    const response = sdkResponse({});
    Object.defineProperty(response, "url", { get: readChallenge });
    f.io.startAuthorization.mockResolvedValue(response);
    f.assertCurrentOwner
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new HostedOperatorError("authorization_required"));
    await expect(
      f.run(context, { callbackUrl: "https://builder.example/callback", phase: "start" }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(readChallenge).not.toHaveBeenCalled();
    expect(f.diagnosticSink.mock.calls.map(([entry]) => entry.stage)).not.toContain(
      "provider_start_projection",
    );
  });
  it("keeps SDK start rejection distinct from post-return projection failure", async () => {
    const f = fixture();
    f.io.startAuthorization.mockRejectedValue(new Error("private-sdk-error"));
    await expect(
      f.run(context, { callbackUrl: "https://builder.example/callback", phase: "start" }),
    ).rejects.toThrow();
    expect(f.assertCurrentOwner).toHaveBeenCalledTimes(2);
    expect(
      f.diagnosticSink.mock.calls.map(([entry]) => [entry.stage, entry.outcome]),
    ).toContainEqual(["provider_start", "setup_unavailable"]);
    expect(f.diagnosticSink.mock.calls.map(([entry]) => entry.stage)).not.toContain(
      "provider_start_projection",
    );
    expect(JSON.stringify(f.diagnosticSink.mock.calls)).not.toContain("private");
  });
});

describe("operator consent diagnostic outcomes", () => {
  it("reports actual provider missing consent separately from current-owner denial", async () => {
    const f = fixture();
    f.io.getTokenResponse.mockRejectedValueOnce(new UserAuthorizationRequiredError("fixture"));
    await expect(f.run(context, { phase: "check" })).resolves.toEqual({
      status: "authorization-required",
    });
    expect(
      f.diagnosticSink.mock.calls.map(([entry]) => [entry.stage, entry.outcome]),
    ).toContainEqual(["provider_token", "consent_required"]);
    const denied = fixture();
    denied.assertCurrentOwner.mockRejectedValueOnce(
      new HostedOperatorError("authorization_required"),
    );
    await expect(denied.run(context, { phase: "check" })).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(denied.io.getTokenResponse).not.toHaveBeenCalled();
    expect(
      denied.diagnosticSink.mock.calls.map(([entry]) => [entry.stage, entry.outcome]),
    ).toContainEqual(["current_owner", "operator_access_denied"]);
  });
  it("reports before the provider await and never logs secret-bearing failures", async () => {
    const f = fixture();
    const secret = "Bearer private-token https://vercel.com/consent?pkce=private";
    f.io.getTokenResponse.mockRejectedValueOnce(new Error(secret));
    await expect(f.run(context, { phase: "complete" })).rejects.toMatchObject({
      code: "operator_unavailable",
    });
    expect(
      f.diagnosticSink.mock.calls.map(([entry]) => [entry.phase, entry.stage, entry.outcome]),
    ).toContainEqual(["complete", "provider_token", "started"]);
    expect(
      f.diagnosticSink.mock.calls.map(([entry]) => [entry.phase, entry.stage, entry.outcome]),
    ).toContainEqual(["complete", "provider_token", "setup_unavailable"]);
    expect(JSON.stringify(f.diagnosticSink.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(f.diagnosticSink.mock.calls)).not.toContain("private-operator-oidc");
  });
});
