import { describe, expect, it } from "vitest";

import {
  exactForwardedSessionAuthority,
  HostedSessionAuthorityError,
} from "./session-authority";

const auth = (overrides: Record<string, unknown> = {}) => ({
  attributes: {
    "mcp:audience": "https://builder.example.test/mcp",
    "mcp:scopes": ["eve:start"],
    "mcp:workspace-id": "workspace_1",
  },
  authenticator: "mcp-oauth-jwks",
  issuer: "https://builder.example.test/api/auth",
  principalId: "user_1",
  principalType: "user",
  subject: "user_1",
  ...overrides,
});

describe("exact forwarded session authority", () => {
  it("returns one exact current and initiating tenant authority", () => {
    expect(
      exactForwardedSessionAuthority({ current: auth(), initiator: auth() }),
    ).toEqual({
      authority: {
        issuer: "https://builder.example.test/api/auth",
        audience: "https://builder.example.test/mcp",
        workspaceId: "workspace_1",
        ownerUserId: "user_1",
      },
      principal: {
        issuer: "https://builder.example.test/api/auth",
        audience: "https://builder.example.test/mcp",
        workspaceId: "workspace_1",
        ownerUserId: "user_1",
        scopes: ["eve:start"],
      },
    });
  });

  it("rejects malformed, substituted, and split authority", () => {
    for (const candidate of [
      {},
      { current: auth({ principalId: "user_2" }), initiator: auth() },
      {
        current: auth(),
        initiator: auth({
          attributes: {
            ...auth().attributes,
            "mcp:workspace-id": "workspace_2",
          },
        }),
      },
    ]) {
      expect(() => exactForwardedSessionAuthority(candidate)).toThrow(
        HostedSessionAuthorityError,
      );
    }
  });
});
