import { describe, expect, it } from "vitest";

import {
  authorizeHostedPrincipal,
  HostedAuthorizationError,
} from "./hosted-auth";

const claims = {
  issuer: "https://identity.example.test",
  audience: "autograph-app-builder",
  subject: "user_1",
  workspaceId: "workspace_1",
  scopes: ["eve:session", "eve:respond"],
};

function authorize(verifiedClaims: unknown = claims) {
  return authorizeHostedPrincipal({
    verifiedClaims,
    expectedIssuer: claims.issuer,
    expectedAudience: claims.audience,
    requiredScopes: ["eve:session", "eve:respond"],
    requestedWorkspaceId: claims.workspaceId,
  });
}

describe("hosted Eve authorization", () => {
  it("creates a closed request-scoped principal from exact verified claims", () => {
    expect(authorize()).toEqual({
      issuer: claims.issuer,
      audience: claims.audience,
      workspaceId: claims.workspaceId,
      ownerUserId: claims.subject,
      scopes: ["eve:respond", "eve:session"],
    });
  });

  it.each([
    ["issuer_mismatch", { ...claims, issuer: "https://other.example.test" }],
    ["audience_mismatch", { ...claims, audience: "another-client" }],
    ["workspace_mismatch", { ...claims, workspaceId: "workspace_2" }],
    ["insufficient_scope", { ...claims, scopes: ["eve:session"] }],
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
