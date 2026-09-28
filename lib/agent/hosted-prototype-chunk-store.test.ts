import { describe, expect, it } from "vitest";

import { createHostedPrototypeChunkStore } from "./hosted-prototype-chunk-store";

const context = (workspaceId: string) => ({
  attributes: {
    "mcp:audience": "https://builder.example/mcp",
    "mcp:scopes": ["autograph:session"],
    "mcp:workspace-id": workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: "https://builder.example/api/auth",
  principalId: "user-1",
  principalType: "user",
  subject: "user-1",
});

describe("hosted prototype chunk authority", () => {
  it("rejects missing or mismatched forwarded session authority before any database access", () => {
    // SAFETY: Authority parsing fails before the database placeholder can be accessed.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Parsing fails before the placeholder is read.
    const db = {} as never;
    expect(() =>
      createHostedPrototypeChunkStore({ db, sessionAuth: null, sessionId: "session-1" }),
    ).toThrow("Hosted session authority is invalid");
    expect(() =>
      createHostedPrototypeChunkStore({
        db,
        sessionAuth: { current: context("workspace-1"), initiator: context("workspace-2") },
        sessionId: "session-1",
      }),
    ).toThrow("Hosted session authority is invalid");
  });
});
