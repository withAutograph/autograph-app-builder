import { describe, expect, it } from "vitest";

import {
  exactForwardedSessionAuthority,
  HostedSessionAuthorityError,
  sourceHandoffIdForSessionAuth,
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
  it("binds prepared context to both the initiating and current authority", () => {
    const handoffId = "123e4567-e89b-42d3-a456-426614174001";
    const prepared = auth({
      attributes: {
        ...auth().attributes,
        "autograph:source-handoff-id": handoffId,
      },
    });
    expect(sourceHandoffIdForSessionAuth({ current: prepared, initiator: prepared })).toBe(
      handoffId,
    );
    expect(sourceHandoffIdForSessionAuth({ current: auth(), initiator: auth() })).toBeUndefined();
    expect(sourceHandoffIdForSessionAuth({ current: null, initiator: null })).toBeUndefined();
    for (const candidate of [
      { current: auth(), initiator: prepared },
      { current: prepared, initiator: auth() },
      {
        current: { ...prepared, subject: "another-user" },
        initiator: prepared,
      },
      { current: prepared, initiator: null },
    ]) {
      expect(() => sourceHandoffIdForSessionAuth(candidate)).toThrow(HostedSessionAuthorityError);
    }
  });
  it("returns one exact current and initiating tenant authority", () => {
    expect(exactForwardedSessionAuthority({ current: auth(), initiator: auth() })).toEqual({
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
      expect(() => exactForwardedSessionAuthority(candidate)).toThrow(HostedSessionAuthorityError);
    }
  });
});
