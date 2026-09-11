import { describe, expect, it } from "vitest";

import {
  builderProvisionRequestDigest,
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  githubProvisionSuccessSchema,
} from "./contracts";
import { deriveBuilderAppId, suffixedProviderName } from "./names";

const request = {
  appName: "Vendor & Crédit Portal",
  operation: "github",
  providers: {
    githubInstallationId: "101",
    vercelInstallationId: "icfg_202",
  },
  repository: { name: "vendor-credit-portal", private: true },
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  version: 1,
} as const;

describe("builder provisioning contracts", () => {
  it("derives the exact target-planning app ID and bounded provider suffixes", () => {
    expect(deriveBuilderAppId(request.appName)).toBe(
      "vendor-and-credit-portal"
    );
    expect(
      suffixedProviderName({
        base: "x".repeat(100),
        maximumLength: 100,
        suffix: "a1b2c3",
      })
    ).toMatch(/^x{93}-a1b2c3$/u);
    expect(() => deriveBuilderAppId("123 only")).toThrow();
  });

  it("uses one operation-independent digest for retries and rejects missing selections", () => {
    const github = builderProvisionRequestSchema.parse(request);
    const vercel = builderProvisionRequestSchema.parse({
      ...request,
      operation: "vercel",
    });
    expect(builderProvisionRequestDigest(github)).toBe(
      builderProvisionRequestDigest(vercel)
    );
    expect(
      builderProvisionRequestSchema.safeParse({
        ...request,
        providers: {},
      }).success
    ).toBe(false);
  });

  it("keeps provider results closed and failures sanitized", () => {
    const parsed = builderProvisionResponseSchema.parse({
      appId: "vendor-and-credit-portal",
      github: {
        code: "provider_rejected",
        retryable: true,
        status: "failed",
      },
      requestDigest: "a".repeat(64),
      requestId: request.requestId,
      status: "settled",
      updatedAt: "2026-08-30T12:00:00.000Z",
      vercel: {
        code: "github_required",
        retryable: true,
        status: "skipped",
      },
      version: 1,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/token|authorization|message/iu);
    expect(
      builderProvisionResponseSchema.safeParse({
        ...parsed,
        github: { ...parsed.github, message: "raw provider error" },
      }).success
    ).toBe(false);
  });

  it("requires complete V4 provenance for cloned starter results", () => {
    const cloned = {
      defaultBranch: "main",
      fullName: "withAutograph/vendor-credit-portal",
      headSha: "1".repeat(40),
      headTree: "2".repeat(40),
      installationId: "101",
      name: "vendor-credit-portal",
      owner: "withAutograph",
      repositoryId: "202",
      scope: {
        id: "303",
        login: "withAutograph",
        type: "organization",
      },
      starter: {
        contractDigest: "8".repeat(64),
        eligibilityDigest: "7".repeat(64),
        method: "git-clone-v1",
        readinessDigest: "5".repeat(64),
        receiptVersion: 4,
        ref: "refs/heads/main",
        repository: "https://github.com/withAutograph/arrusted-development.git",
        sourceReceiptDigest: "6".repeat(64),
        sourceSha: "3".repeat(40),
        sourceTree: "4".repeat(40),
      },
      status: "succeeded",
      url: "https://github.com/withAutograph/vendor-credit-portal",
      visibility: "private",
    } as const;
    expect(githubProvisionSuccessSchema.safeParse(cloned).success).toBe(true);
    expect(
      githubProvisionSuccessSchema.safeParse({
        ...cloned,
        starter: {
          ...cloned.starter,
          sourceReceiptDigest: undefined,
        },
      }).success
    ).toBe(false);
    expect(
      githubProvisionSuccessSchema.safeParse({
        ...cloned,
        starter: {
          method: "starter-archive-v3",
          sourceSha: cloned.starter.sourceSha,
          sourceTree: cloned.starter.sourceTree,
        },
      }).success
    ).toBe(true);
  });
});
