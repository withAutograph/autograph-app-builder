import { describe, expect, it } from "vitest";

import type { ProviderEmulation } from "../integrations/local-provider-emulation";
import {
  parseLocalOAuthAuthorization,
  signLocalOAuthApproval,
  verifyLocalOAuthApproval,
} from "./local-oauth-approval";

const emulation: ProviderEmulation = {
  canonicalOrigin: "https://localhost:3001",
  githubClientId: "github-client",
  githubClientSecret: "g".repeat(20),
  githubOrigin: "http://localhost:4001",
  githubRepository: "autograph-local/demo-app",
  mode: "local",
  relaySecret: "a".repeat(32),
  token: "emulate_local_provider_token",
  vercelClientId: "vercel-client",
  vercelClientSecret: "v".repeat(20),
  vercelOrigin: "http://localhost:4000",
};

const base = {
  appOrigin: "https://localhost:3001",
  emulation,
  githubClientId: "github-client",
  provider: "github",
  values: {
    client_id: "github-client",
    code_challenge: "b".repeat(43),
    code_challenge_method: "S256",
    redirect_uri: "https://localhost:3001/api/auth/callback/github",
    response_type: "code",
    scope: "read:user user:email",
    state: "a".repeat(32),
  },
  vercelClientId: "vercel-client",
} as const;

describe("local OAuth approval", () => {
  it("accepts an exact app-owned GitHub authorization", () => {
    expect(parseLocalOAuthAuthorization(base)).toMatchObject({
      authorization: {
        client_id: "github-client",
        redirect_uri: "https://localhost:3001/api/auth/callback/github",
      },
      provider: "github",
    });
  });

  it.each([
    { client_id: "other-client" },
    { redirect_uri: "https://example.com/api/auth/callback/github" },
    { response_type: "token" },
    { code_challenge_method: undefined },
  ])("rejects a malformed or unbound authorization", (override) => {
    expect(() =>
      parseLocalOAuthAuthorization({
        ...base,
        values: { ...base.values, ...override },
      })
    ).toThrow();
  });

  it("signs a short-lived approval bound to provider and origin", () => {
    const { authorization } = parseLocalOAuthAuthorization(base);
    const approval = signLocalOAuthApproval(
      {
        authorization,
        expiresAt: 2_000,
        origin: emulation.canonicalOrigin,
        provider: "github",
      },
      emulation.relaySecret
    );
    expect(
      verifyLocalOAuthApproval(approval, emulation.relaySecret, 1000)
    ).toEqual({
      authorization,
      expiresAt: 2_000,
      origin: emulation.canonicalOrigin,
      provider: "github",
    });
    expect(() =>
      verifyLocalOAuthApproval(`${approval}x`, emulation.relaySecret, 1000)
    ).toThrow("invalid-approval");
    expect(() =>
      verifyLocalOAuthApproval(approval, emulation.relaySecret, 2000)
    ).toThrow("expired-approval");
  });
});
