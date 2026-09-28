import { describe, expect, it } from "vitest";

import { createGitHubInstallationIdentity, githubPermissionsFor } from "./github-publication";
import { assertGitHubAccessIdentityForRepository } from "./github-access-identity";
import { issueGitHubTargetAccessProof } from "./github-target-access-proof";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};

describe("GitHub access identity compatibility", () => {
  it("keeps a saved v2 selection valid for its repository", () => {
    const identity = createGitHubInstallationIdentity({
      accountId: "88",
      accountLogin: "withAutograph",
      accountType: "Organization",
      installationId: "101",
      operation: "resolve-existing-source",
      repositorySelection: "selected",
      selectedRepositoryIds: ["100", "200"],
    });
    expect(() => {
      assertGitHubAccessIdentityForRepository({
        authority,
        identity,
        operation: "resolve-existing-source",
        repositoryId: "200",
      });
    }).not.toThrow();
    expect(() => {
      assertGitHubAccessIdentityForRepository({
        authority,
        identity,
        operation: "resolve-existing-source",
        repositoryId: "300",
      });
    }).toThrow("github-access-target-mismatch");
  });

  it("binds v3 proof to the target and tenant", () => {
    const identity = issueGitHubTargetAccessProof({
      authority,
      installation: {
        accountId: "88",
        accountLogin: "withAutograph",
        accountType: "Organization",
        installationId: "101",
      },
      observed: {
        installationId: "101",
        permissions: githubPermissionsFor("resolve-existing-source"),
        repositoryId: "200",
      },
      operation: "resolve-existing-source",
      repositoryId: "200",
    });
    expect(() => {
      assertGitHubAccessIdentityForRepository({
        authority,
        identity,
        operation: "resolve-existing-source",
        repositoryId: "200",
      });
    }).not.toThrow();
    expect(() => {
      assertGitHubAccessIdentityForRepository({
        authority: { ...authority, workspaceId: "other" },
        identity,
        operation: "resolve-existing-source",
        repositoryId: "200",
      });
    }).toThrow("github-target-access-proof-invalid");
  });
});
