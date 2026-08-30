import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptGitHubUserTokens,
  encryptGitHubUserTokens,
  githubCredentialAssociatedData,
  readGitHubUserCredentialEnvironment,
} from "./github-user-credential";

const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
};

describe("GitHub user credential envelope", () => {
  it("uses a dedicated versioned key and tenant-bound associated data", () => {
    const key = randomBytes(32);
    const config = readGitHubUserCredentialEnvironment({
      GITHUB_APP_USER_TOKEN_KEY: key.toString("base64"),
      GITHUB_APP_USER_TOKEN_KEY_VERSION: "v1",
    });
    const associatedData = githubCredentialAssociatedData({
      authority,
      providerUserId: "123",
    });
    const tokens = {
      accessToken: "github-access-token-value",
      accessTokenExpiresAt: "2026-08-30T13:00:00.000Z",
      refreshToken: "github-refresh-token-value",
      refreshTokenExpiresAt: "2027-02-26T12:00:00.000Z",
    };
    const encrypted = encryptGitHubUserTokens({
      tokens,
      key: config.key,
      associatedData,
    });
    expect(JSON.stringify(encrypted)).not.toContain(tokens.accessToken);
    expect(
      decryptGitHubUserTokens({
        ...encrypted,
        key: config.key,
        associatedData,
      }),
    ).toEqual(tokens);
    expect(() =>
      decryptGitHubUserTokens({
        ...encrypted,
        key: config.key,
        associatedData: `${associatedData}-other-tenant`,
      }),
    ).toThrow();
  });
});
