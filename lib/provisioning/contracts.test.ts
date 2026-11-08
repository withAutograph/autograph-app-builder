import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  builderProvisionRequestDigest,
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  githubProvisionSuccessSchema,
  initialBuilderProvisionResponse,
  vercelProvisionSuccessSchema,
} from "./contracts";
import {
  initialBuilderProvisionJournalRecord,
  builderProvisionJournalRecordSchema,
} from "./journal";

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
  it("persists public access intent while preserving legacy request digests and journal rows", () => {
    const legacy = builderProvisionRequestSchema.parse(request);
    const oldDigest = createHash("sha256")
      .update(
        JSON.stringify({
          appName: request.appName,
          providers: request.providers,
          repository: request.repository,
          requestId: request.requestId,
          version: request.version,
        }),
      )
      .digest("hex");
    expect(builderProvisionRequestDigest(legacy)).toBe(oldDigest);
    const publicRequest = builderProvisionRequestSchema.parse({
      ...request,
      deploymentAccess: "public-app",
    });
    expect(builderProvisionRequestDigest(publicRequest)).not.toBe(oldDigest);
    const now = new Date("2026-11-03T00:00:00Z");
    const journal = initialBuilderProvisionJournalRecord(publicRequest, now);
    expect(builderProvisionJournalRecordSchema.parse(journal).request.deploymentAccess).toBe(
      "public-app",
    );
    expect(journal.response.deploymentAccess).toBe("public-app");
    expect(initialBuilderProvisionResponse(legacy, now)).not.toHaveProperty("deploymentAccess");
    expect(initialBuilderProvisionJournalRecord(legacy, now).request).not.toHaveProperty(
      "deploymentAccess",
    );
  });

  it("persists public access intent while preserving legacy request digests and journal rows", () => {
    const legacy = builderProvisionRequestSchema.parse(request);
    const oldDigest = createHash("sha256")
      .update(
        JSON.stringify({
          appName: request.appName,
          providers: request.providers,
          repository: request.repository,
          requestId: request.requestId,
          version: request.version,
        }),
      )
      .digest("hex");
    expect(builderProvisionRequestDigest(legacy)).toBe(oldDigest);
    const publicRequest = builderProvisionRequestSchema.parse({
      ...request,
      deploymentAccess: "public-app",
    });
    expect(builderProvisionRequestDigest(publicRequest)).not.toBe(oldDigest);
    const now = new Date("2026-11-03T00:00:00Z");
    const journal = initialBuilderProvisionJournalRecord(publicRequest, now);
    expect(builderProvisionJournalRecordSchema.parse(journal).request.deploymentAccess).toBe(
      "public-app",
    );
    expect(journal.response.deploymentAccess).toBe("public-app");
    expect(initialBuilderProvisionResponse(legacy, now)).not.toHaveProperty("deploymentAccess");
    expect(initialBuilderProvisionJournalRecord(legacy, now).request).not.toHaveProperty(
      "deploymentAccess",
    );
  });

  it("reads both Services projects and historical app-root receipts", () => {
    const project = {
      dashboardUrl: "https://vercel.com/owner/apps-spend-review",
      framework: "services",
      installationId: "icfg_owner",
      name: "apps-spend-review",
      projectId: "prj_services",
      rootDirectory: ".",
      scope: { id: "team_owner", slug: "owner", type: "team" },
      status: "succeeded",
    };
    expect(vercelProvisionSuccessSchema.safeParse(project).success).toBe(true);
    expect(
      vercelProvisionSuccessSchema.safeParse({
        ...project,
        framework: "nextjs",
        rootDirectory: "apps/spend-review",
      }).success,
    ).toBe(true);
  });
  it("derives the exact target-planning app ID and bounded provider suffixes", () => {
    expect(deriveBuilderAppId(request.appName)).toBe("vendor-and-credit-portal");
    expect(
      suffixedProviderName({
        base: "x".repeat(100),
        maximumLength: 100,
        suffix: "a1b2c3",
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
    expect(builderProvisionRequestDigest(github)).toBe(builderProvisionRequestDigest(vercel));
    expect(
      builderProvisionRequestSchema.safeParse({
        ...request,
        providers: {},
      }).success,
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
      }).success,
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
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
          sourceReceiptDigest: undefined,
        },
      }).success,
    ).toBe(false);
    expect(
      githubProvisionSuccessSchema.safeParse({
        ...cloned,
        starter: {
          method: "starter-archive-v3",
          sourceSha: cloned.starter.sourceSha,
          sourceTree: cloned.starter.sourceTree,
        },
      }).success,
    ).toBe(true);
  });
});
