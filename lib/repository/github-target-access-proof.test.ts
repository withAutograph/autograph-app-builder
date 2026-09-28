import { describe, expect, it } from "vitest";

import { githubPermissionsFor } from "./github-publication";
import {
  issueGitHubTargetAccessProof,
  parseGitHubTargetAccessProof,
} from "./github-target-access-proof";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};

const input = {
  authority,
  installation: {
    accountId: "88",
    accountLogin: "withAutograph",
    accountType: "Organization" as const,
    installationId: "101",
  },
  observed: {
    installationId: "101",
    permissions: githubPermissionsFor("resolve-existing-source"),
    repositoryId: "10001",
  },
  operation: "resolve-existing-source" as const,
  repositoryId: "10001",
};

describe("target-scoped GitHub access proof", () => {
  it("binds one verified repository and tenant without carrying an installation inventory", () => {
    const proof = issueGitHubTargetAccessProof(input);
    expect(proof).not.toHaveProperty("selectedRepositoryIds");
    expect(parseGitHubTargetAccessProof(proof, authority)).toEqual(proof);
    expect(() =>
      parseGitHubTargetAccessProof(proof, { ...authority, workspaceId: "other" }),
    ).toThrow("github-target-access-proof-invalid");
  });

  it("rejects a mismatched observation and an altered proof", () => {
    expect(() =>
      issueGitHubTargetAccessProof({
        ...input,
        observed: { ...input.observed, repositoryId: "10002" },
      }),
    ).toThrow("github-target-access-observation-mismatch");
    const proof = issueGitHubTargetAccessProof(input);
    expect(() =>
      parseGitHubTargetAccessProof({ ...proof, repositoryId: "10002" }, authority),
    ).toThrow("github-target-access-proof-invalid");
  });
});
