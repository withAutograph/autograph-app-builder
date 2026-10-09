import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
/* oxlint-disable eslint/require-await -- Synthetic Eve authorization callbacks preserve the async provider contract. */
import { describe, expect, it, vi } from "vitest";
import type { InteractiveAuthorizationDefinition } from "eve/connections";
import type { ToolContext } from "eve/tools";
import { authorizeHostedNeonForTool } from "./hosted-neon-authorization";
import type { createHostedOperatorClient } from "../provisioning/hosted-operator-client";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "canonical-owner",
  workspaceId: "workspace",
};
const principal = { id: authority.ownerUserId, issuer: authority.issuer, type: "user" as const };
const fixture = () => {
  let provider: InteractiveAuthorizationDefinition | undefined;
  const getToken = vi.fn<ToolContext["getToken"]>(async (value) => {
    if (value.startAuthorization === undefined || value.completeAuthorization === undefined) {
      throw new Error("Expected interactive provider");
    }
    provider = value;
    return { token: "inline-readiness" };
  });
  const ctx = { abortSignal: new AbortController().signal, getToken };
  const operator = {
    neonAuthorization: vi.fn<ReturnType<typeof createHostedOperatorClient>["neonAuthorization"]>(
      async () => ({ expiresAt: Date.now() + 60_000, status: "ready" }),
    ),
    ownerContext: {
      adapterGeneration: 3,
      adapterSessionId: "adapter-session",
      authority,
      kind: "direct" as const,
      principal: { ...authority, scopes: ["builder:read"] },
      sessionId: "canonical-session",
    },
    sessionId: "canonical-session",
  };
  return {
    ctx,
    getToken,
    operator,
    provider: () => {
      if (!provider) {
        throw new Error("No inline provider");
      }
      return provider;
    },
  };
};
describe("original Builder owner inline Neon authorization", () => {
  it("returns a safe blocked code for unavailable operator transport", async () => {
    const f = fixture();
    f.getToken.mockRejectedValueOnce(new HostedOperatorError("operator_unavailable"));
    await expect(authorizeHostedNeonForTool(f.ctx, f.operator)).resolves.toBe(
      "operator_unavailable",
    );
  });
  it("preserves Eve's authorization pause signal rather than converting it to a blocked result", async () => {
    const f = fixture();
    const signal = {
      kind: "authorization-required",
      url: "https://vercel.com/connect/authorize?opaque",
    };
    f.getToken.mockRejectedValueOnce(signal);
    await expect(authorizeHostedNeonForTool(f.ctx, f.operator)).rejects.toBe(signal);
  });
  it("uses ordinary Eve authorization with canonical session and generation", async () => {
    const f = fixture();
    await authorizeHostedNeonForTool(f.ctx, f.operator);
    expect(f.getToken).toHaveBeenCalledWith(expect.anything(), {
      authKey: "hosted-neon:canonical-session:3",
      displayName: "Connect Neon",
    });
    await f.provider().getToken({ connection: { url: "https://mcp.neon.tech/mcp" }, principal });
    expect(f.operator.neonAuthorization).toHaveBeenCalledWith(
      {
        action: "neon-authorization",
        phase: "check",
        sessionId: "canonical-session",
      },
      f.ctx.abortSignal,
    );
  });
  it("parks on missing owner consent instead of converting Eve's control flow to a blocked tool result", async () => {
    const f = fixture();
    f.operator.neonAuthorization.mockResolvedValue({ status: "authorization-required" });
    await authorizeHostedNeonForTool(f.ctx, f.operator);
    await expect(
      f.provider().getToken({ connection: { url: "https://mcp.neon.tech/mcp" }, principal }),
    ).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
  });
  it("journals only the ordinary public challenge and rechecks real grant on completion", async () => {
    const f = fixture();
    const challenge = {
      displayName: "Connect Neon" as const,
      url: "https://vercel.com/connect/authorize?opaque",
    };
    f.operator.neonAuthorization
      .mockResolvedValueOnce({ challenge, status: "authorization-started" })
      .mockResolvedValueOnce({ expiresAt: Date.now() + 60_000, status: "ready" });
    await authorizeHostedNeonForTool(f.ctx, f.operator);
    await expect(
      f.provider().startAuthorization({
        callbackUrl: "https://builder.example/_workflow/callback/opaque",
        connection: { url: "https://mcp.neon.tech/mcp" },
        principal,
      }),
    ).resolves.toEqual({ challenge });
    await f.provider().completeAuthorization({
      callback: { method: "GET", params: {} },
      callbackUrl: "https://builder.example/_workflow/callback/opaque",
      connection: { url: "https://mcp.neon.tech/mcp" },
      principal,
    });
    expect(f.operator.neonAuthorization.mock.calls[1]?.[0].phase).toBe("complete");
  });
  it("never requests consent as a different Eve principal", async () => {
    const f = fixture();
    await authorizeHostedNeonForTool(f.ctx, f.operator);
    await expect(
      f.provider().startAuthorization({
        callbackUrl: "https://builder.example/callback",
        connection: { url: "https://mcp.neon.tech/mcp" },
        principal: { ...principal, id: "other-owner" },
      }),
    ).rejects.toMatchObject({ reason: "principal_mismatch" });
    expect(f.operator.neonAuthorization).not.toHaveBeenCalled();
  });
  it("does not claim authorization complete because the browser returned", async () => {
    const f = fixture();
    await authorizeHostedNeonForTool(f.ctx, f.operator);
    f.operator.neonAuthorization.mockResolvedValue({ status: "authorization-required" });
    await expect(
      f.provider().completeAuthorization({
        callback: { method: "GET", params: {} },
        callbackUrl: "https://builder.example/callback",
        connection: { url: "https://mcp.neon.tech/mcp" },
        principal,
      }),
    ).rejects.toMatchObject({ reason: "authorization_incomplete" });
  });
});
