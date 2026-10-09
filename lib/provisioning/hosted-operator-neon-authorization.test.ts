/* oxlint-disable eslint/require-await -- Injected SDK fixture methods intentionally preserve Promise contracts. */
import { describe, expect, it, vi } from "vitest";
import { UserAuthorizationRequiredError } from "@vercel/connect";
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
  const assertCurrentOwner = vi.fn(async () => {});
  const io = {
    getOidc: vi.fn(async () => "private-operator-oidc"),
    getTokenResponse: vi.fn(async () => ({
      connector: { id: "connector-id", type: "oauth", uid: "mcp.neon.tech/neon-preview-operator" },
      expiresAt: Date.now() + 60_000,
      token: "private-provider-token",
    })),
    startAuthorization: vi.fn(async () => ({
      expiresAt: Date.now() + 60_000,
      request: "private-request",
      url: "https://vercel.com/connect/authorize?request=opaque",
      verifier: "private-verifier",
    })),
    verifyOidc: vi.fn(async () => {}),
  };
  return {
    assertCurrentOwner,
    io,
    run: createHostedOperatorNeonAuthorization({ assertCurrentOwner, configuration }, io),
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
  it("rejects a consent URL outside the provider origin", async () => {
    const f = fixture();
    f.io.startAuthorization.mockResolvedValue({
      expiresAt: Date.now() + 60_000,
      request: "private",
      url: "https://foreign.example/consent",
      verifier: "private",
    });
    await expect(
      f.run(context, { callbackUrl: "https://builder.example/callback", phase: "start" }),
    ).rejects.toThrow();
  });
});
