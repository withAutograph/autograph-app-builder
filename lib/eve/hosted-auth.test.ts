import { describe, expect, it } from "vitest";

import {
  authorizeHostedPrincipal,
  HostedAuthorizationError,
} from "./hosted-auth";

const claims = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://identity.example.test",
  scopes: ["autograph:session", "autograph:respond"],
  subject: "user_1",
  workspaceId: "workspace_1",
};

function authorize(verifiedClaims: unknown = claims) {
  return authorizeHostedPrincipal({
    expectedAudience: claims.audience,
    expectedIssuer: claims.issuer,
    requiredScopes: ["autograph:session", "autograph:respond"],
    verifiedClaims,
  });
}

describe("hosted Eve authorization", () => {
  it("creates a closed request-scoped principal from exact verified claims", () => {
    expect(authorize()).toEqual({
      audience: claims.audience,
      issuer: claims.issuer,
      ownerUserId: claims.subject,
      scopes: ["autograph:respond", "autograph:session"],
      workspaceId: claims.workspaceId,
    });
  });

  it.each([
    ["issuer_mismatch", { ...claims, issuer: "https://other.example.test" }],
    ["audience_mismatch", { ...claims, audience: "another-client" }],
    ["insufficient_scope", { ...claims, scopes: ["autograph:session"] }],
    ["invalid_claims", { ...claims, unexpected: "claim" }],
    ["invalid_claims", { ...claims, audience: [claims.audience] }],
  ])("rejects %s claims", (code, candidate) => {
    try {
      authorize(candidate);
      throw new Error("Expected authorization to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(HostedAuthorizationError);
      expect((error as HostedAuthorizationError).code).toBe(code);
    }
  });
});
