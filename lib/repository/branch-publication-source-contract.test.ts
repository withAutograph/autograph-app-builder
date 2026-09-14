import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSupportedRepositoryFixture } from "../../evals/support/supported-repository";
import { inspectSourceReceipt } from "./source-receipt";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import { stableDigest } from "./local-publication";
import { deriveBranchWorktreePublicationProposal } from "./node-branch-worktree-publication";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it("uses the actual source receipt identity for branch snapshots and rejects a changed HEAD", async () => {
  const repository = createSupportedRepositoryFixture();
  const publicationRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "branch-contract-")));
  roots.push(repository, publicationRoot);
  vi.stubEnv("REPOSITORY_LOCAL_ROOTS", repository);
  vi.stubEnv("APP_BUILDER_BRANCH_WORKTREE_PUBLICATION", "1");
  vi.stubEnv("APP_BUILDER_BRANCH_WORKTREE_ROOT", publicationRoot);
  const sourceReceipt = await inspectSourceReceipt("existing-repository", repository);
  const digest = "a".repeat(64);
  const unsigned = {
    appSpecDigest: digest,
    appSpecPath: "app-spec.json",
    applyDigest: digest,
    approvedPaths: ["new-file.txt"],
    artifactRevision: "1",
    changedContentDigest: digest,
    changes: [{ after: { digest, mode: "644" }, kind: "added" as const, path: "new-file.txt" }],
    contractDigest: digest,
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
      contractPath: "contract.json",
      topology: { newDigest: digest, oldDigest: digest, path: "microfrontends.json" },
      version: 1 as const,
    },
    validationDigest: digest,
    version: 2 as const,
    workspaceDigest: digest,
  };
  const review = createReviewedChangeSetReceipt(
    { ...unsigned, digest: stableDigest(unsigned) },
    "review-call",
  );
  const proposal = await deriveBranchWorktreePublicationProposal({ review, sourceReceipt });
  expect(proposal.contractDigest).toBe(sourceReceipt.contractDigest);
  expect(proposal.baseSha).toBe(sourceReceipt.sourceSha);
  execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "advance source",
    ],
    { cwd: repository },
  );
  await expect(deriveBranchWorktreePublicationProposal({ review, sourceReceipt })).rejects.toThrow(
    "not the exact reviewed existing repository",
  );
});
