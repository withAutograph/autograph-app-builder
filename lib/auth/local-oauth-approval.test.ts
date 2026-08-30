import { describe, expect, it } from "vitest";

import type { LocalProviderEmulation } from "../integrations/local-provider-emulation";
import { parseLocalOAuthAuthorization } from "./local-oauth-approval";

const emulation: LocalProviderEmulation = {
  githubOrigin: "http://localhost:4001",
  vercelOrigin: "http://localhost:4000",
  token: "emulate_local_provider_token",
  githubRepository: "autograph-local/demo-app",
  relaySecret: "a".repeat(32),
};

const base = {
  provider: "github",
  appOrigin: "https://localhost:3001",
  emulation,
  githubClientId: "github-client",
  vercelClientId: "vercel-client",
  values: {
    response_type: "code",
    client_id: "github-client",
    state: "a".repeat(32),
    scope: "read:user user:email",
    redirect_uri: "https://localhost:3001/api/auth/callback/github",
    code_challenge: "b".repeat(43),
    code_challenge_method: "S256",
  },
} as const;

describe("local OAuth approval", () => {
  it("accepts an exact app-owned GitHub authorization", () => {
    expect(parseLocalOAuthAuthorization(base)).toMatchObject({
      provider: "github",
      authorization: {
        client_id: "github-client",
        redirect_uri: "https://localhost:3001/api/auth/callback/github",
      },
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
      }),
    ).toThrow();
  });
});
