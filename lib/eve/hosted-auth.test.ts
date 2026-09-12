import { describe, expect, it } from "vitest";

import { authorizeHostedPrincipal, HostedAuthorizationError } from "./hosted-auth";

const claims = {
  issuer: "https://identity.example.test",
  audience: "https://builder.example.test/mcp",
  subject: "user_1",
  workspaceId: "workspace_1",
  scopes: ["autograph:session", "autograph:respond"],
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function authorize(verifiedClaims: unknown = claims) {
  return authorizeHostedPrincipal({
    verifiedClaims,
    expectedIssuer: claims.issuer,
    expectedAudience: claims.audience,
    requiredScopes: ["autograph:session", "autograph:respond"],
  });
}

describe("hosted Eve authorization", () => {
  it("creates a closed request-scoped principal from exact verified claims", () => {
    expect(authorize()).toEqual({
      issuer: claims.issuer,
      audience: claims.audience,
      workspaceId: claims.workspaceId,
      ownerUserId: claims.subject,
      scopes: ["autograph:respond", "autograph:session"],
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
