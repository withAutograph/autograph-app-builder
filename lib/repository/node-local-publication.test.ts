import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createSupportedRepositoryFixture } from "../../evals/support/supported-repository";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import { contentDigest, stableDigest } from "./local-publication";
import { inspectSourceReceipt } from "./source-receipt";
import {
  deriveLocalPublicationProposal,
  publishReviewedChangeSet,
  verifyPublishedChangeSet,
} from "./node-local-publication";
import type { SourceReceipt } from "./source-receipt";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createSource = async () => {
  const repository = createSupportedRepositoryFixture();
  roots.push(repository);
  vi.stubEnv("REPOSITORY_LOCAL_ROOTS", repository);
  vi.stubEnv("APP_BUILDER_LOCAL_PUBLICATION", "1");
  const sourceReceipt = await inspectSourceReceipt("existing-repository", repository);
  return { repository, sourceReceipt };
};

const createReview = (sourceReceipt: SourceReceipt, relativePath: string, bytes: Buffer) => {
  const digest = "a".repeat(64);
  const unsigned = {
    appSpecDigest: digest,
    appSpecPath: "apps/spend-review/app-spec.json",
    applyDigest: digest,
    approvedPaths: [relativePath],
    artifactRevision: "1",
    changedContentDigest: digest,
    changes: [
      {
        after: { digest: contentDigest(bytes), mode: "644" },
        kind: "added" as const,
        path: relativePath,
      },
    ],
    contractDigest: sourceReceipt.contractDigest,
    dependencyCacheContentDigest: digest,
    dependencyCacheDigest: digest,
    dependencyReceiptDigest: digest,
    eligibilityDigest: sourceReceipt.eligibilityDigest,
    identityDigest: digest,
    imageDigest: digest,
    postTreeDigest: digest,
    preTreeDigest: digest,
    proposalDigest: digest,
    repositoryContractDigest: sourceReceipt.contractDigest,
    sourceReceiptDigest: sourceReceipt.digest,
    sourceSha: sourceReceipt.sourceSha,
    sourceTree: sourceReceipt.sourceTree,
    targetReceipt: {
      topology: { newDigest: digest, oldDigest: digest, path: "microfrontends.json" },
      version: 1 as const,
    },
    validationDigest: digest,
    version: 2 as const,
    workspaceDigest: digest,
  };
  return createReviewedChangeSetReceipt(
    { ...unsigned, digest: stableDigest(unsigned) },
    "local-publication-test-review",
  );
};

const prepareProposal = async (
  repository: string,
  sourceReceipt: SourceReceipt,
  review: ReviewedChangeSetReceipt,
) =>
  await deriveLocalPublicationProposal({
    destinationPath: repository,
    review,
    sourceReceipt,
  });

it("publishes exact bytes larger than the former per-file ceiling", async () => {
  const { repository, sourceReceipt } = await createSource();
  const relativePath = "apps/spend-review/schema/release/large.json";
  const bytes = randomBytes(12 * 1024 * 1024);
  const review = createReview(sourceReceipt, relativePath, bytes);
  const proposal = await prepareProposal(repository, sourceReceipt, review);
  const result = await publishReviewedChangeSet({
    proposal,
    publishedByCallId: "large-local-publication-test",
    readOverlayFile: async (filePath) =>
      await Promise.resolve(filePath === relativePath ? bytes : null),
    review,
    sourceReceipt,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(readFileSync(path.join(repository, relativePath))).toEqual(bytes);
  await verifyPublishedChangeSet({ receipt: result.receipt, review, sourceReceipt });
}, 60_000);

it("leaves no partial file when the local Git apply provider fails before mutation", async () => {
  const { repository, sourceReceipt } = await createSource();
  const relativePath = "apps/spend-review/schema/release/rejected.json";
  const bytes = Buffer.from("approved bytes");
  const review = createReview(sourceReceipt, relativePath, bytes);
  const proposal = await prepareProposal(repository, sourceReceipt, review);
  const result = await publishReviewedChangeSet({
    hooks: {
      dispatchGitApply: async () => {
        await Promise.reject(new Error("forced local apply failure"));
      },
    },
    proposal,
    publishedByCallId: "failed-local-publication-test",
    readOverlayFile: async (filePath) =>
      await Promise.resolve(filePath === relativePath ? bytes : null),
    review,
    sourceReceipt,
  });

  expect(result.ok).toBe(false);
  expect(existsSync(path.join(repository, relativePath))).toBe(false);
});
