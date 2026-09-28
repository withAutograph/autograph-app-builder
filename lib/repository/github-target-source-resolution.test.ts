import { describe, expect, it } from "vitest";

import { createGitHubTargetSourceResolutionAdapter } from "./github-app-adapter";
import type { githubPermissionsFor } from "./github-permissions";
import {
  resolveImmutableExistingSourceWithTargetProof,
  assertExactImmutableGitHubSourceReceipt,
} from "./github-publication";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};

const sourceSha = "1".repeat(40);
const sourceTree = "2".repeat(40);

const provider = {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async inspectRepository() {
    return {
      defaultBranch: "main",
      headSha: sourceSha,
      headTree: sourceTree,
      name: "spend-review",
      owner: "withAutograph",
      repositoryId: "200",
      repositoryVariableNames: [],
      visibility: "private",
    };
  },
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async inspectTargetAccess({
    requestedPermissions,
  }: {
    requestedPermissions: ReturnType<typeof githubPermissionsFor>;
  }) {
    return {
      accountId: "88",
      accountLogin: "withAutograph",
      accountType: "Organization",
      installationId: "101",
      permissions: requestedPermissions,
      repositoryId: "200",
    };
  },
};

describe("target-bound existing source resolution", () => {
  it("issues a v2-compatible immutable receipt bound to a v3 target proof", async () => {
    const adapter = createGitHubTargetSourceResolutionAdapter(provider, authority);
    const receipt = await resolveImmutableExistingSourceWithTargetProof({
      adapter,
      authority,
      expectedInstallationId: "101",
      expectedSha: sourceSha,
      expectedTree: sourceTree,
      ref: "refs/heads/main",
      repositoryId: "200",
      resolvedByCallId: "call-1",
    });
    assertExactImmutableGitHubSourceReceipt(receipt);
    expect(receipt.repository.installationIdentityDigest).toBe(receipt.installationIdentityDigest);
  });

  it("rejects a different tenant before reading the repository", async () => {
    const adapter = createGitHubTargetSourceResolutionAdapter(provider, authority);
    await expect(
      resolveImmutableExistingSourceWithTargetProof({
        adapter,
        authority: { ...authority, workspaceId: "other" },
        expectedInstallationId: "101",
        expectedSha: sourceSha,
        expectedTree: sourceTree,
        ref: "refs/heads/main",
        repositoryId: "200",
        resolvedByCallId: "call-1",
      }),
    ).rejects.toThrow("github-target-access-proof-invalid");
  });
});
