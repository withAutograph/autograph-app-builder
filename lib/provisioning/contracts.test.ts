import { describe, expect, it } from "vitest";

import {
  builderProvisionRequestDigest,
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  githubProvisionSuccessSchema,
} from "./contracts";
import { deriveBuilderAppId, suffixedProviderName } from "./names";

const request = {
  version: 1,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  operation: "github",
  appName: "Vendor & Crédit Portal",
  repository: { name: "vendor-credit-portal", private: true },
  providers: {
    githubInstallationId: "101",
    vercelInstallationId: "icfg_202",
  },
} as const;

describe("builder provisioning contracts", () => {
  it("derives the exact target-planning app ID and bounded provider suffixes", () => {
    expect(deriveBuilderAppId(request.appName)).toBe(
      "vendor-and-credit-portal",
    );
    expect(
      suffixedProviderName({
        base: "x".repeat(100),
        suffix: "a1b2c3",
        maximumLength: 100,
      }),
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
      builderProvisionRequestDigest(vercel),
    );
    expect(
      builderProvisionRequestSchema.safeParse({
        ...request,
        providers: {},
      }).success,
    ).toBe(false);
  });

  it("keeps provider results closed and failures sanitized", () => {
    const parsed = builderProvisionResponseSchema.parse({
      version: 1,
      requestId: request.requestId,
      requestDigest: "a".repeat(64),
      appId: "vendor-and-credit-portal",
      status: "settled",
      github: {
        status: "failed",
        code: "provider_rejected",
        retryable: true,
      },
      vercel: {
        status: "skipped",
        code: "github_required",
        retryable: true,
      },
      updatedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(JSON.stringify(parsed)).not.toMatch(/token|authorization|message/iu);
    expect(
      builderProvisionResponseSchema.safeParse({
        ...parsed,
        github: { ...parsed.github, message: "raw provider error" },
      }).success,
    ).toBe(false);
  });

  it("requires complete V4 provenance for cloned starter results", () => {
    const cloned = {
      status: "succeeded",
      installationId: "101",
      repositoryId: "202",
      owner: "withAutograph",
      name: "vendor-credit-portal",
      fullName: "withAutograph/vendor-credit-portal",
      url: "https://github.com/withAutograph/vendor-credit-portal",
      scope: {
        type: "organization",
        id: "303",
        login: "withAutograph",
      },
      visibility: "private",
      defaultBranch: "main",
      headSha: "1".repeat(40),
      headTree: "2".repeat(40),
      starter: {
        sourceSha: "3".repeat(40),
        sourceTree: "4".repeat(40),
        repository: "https://github.com/withAutograph/arrusted-development.git",
        ref: "refs/heads/main",
        method: "git-clone-v1",
        readinessDigest: "5".repeat(64),
        receiptVersion: 4,
        sourceReceiptDigest: "6".repeat(64),
        eligibilityDigest: "7".repeat(64),
        contractDigest: "8".repeat(64),
      },
    } as const;
    expect(githubProvisionSuccessSchema.safeParse(cloned).success).toBe(true);
    expect(
      githubProvisionSuccessSchema.safeParse({
        ...cloned,
        starter: {
          ...cloned.starter,
          sourceReceiptDigest: undefined,
        },
      }).success,
    ).toBe(false);
    expect(
      githubProvisionSuccessSchema.safeParse({
        ...cloned,
        starter: {
          sourceSha: cloned.starter.sourceSha,
          sourceTree: cloned.starter.sourceTree,
          method: "starter-archive-v3",
        },
      }).success,
    ).toBe(true);
  });
});
