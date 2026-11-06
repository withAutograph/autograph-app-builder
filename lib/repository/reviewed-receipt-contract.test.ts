import { describe, expect, it } from "vitest";
import { assertExactReviewedChangeSet, stableDigest } from "./local-publication";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";

const producedReceipt = () => {
  const hash = "a".repeat(64);
  const changes = [
    {
      after: { digest: hash, mode: "644" },
      kind: "added" as const,
      path: "apps/demo/app/page.tsx",
    },
  ];
  const unsigned = {
    appSpecDigest: hash,
    appSpecPath: "prototype/demo/app-spec.md",
    applyDigest: hash,
    approvedPaths: changes.map(({ path }) => path),
    artifactRevision: hash,
    changedContentDigest: stableDigest(changes),
    changes,
    contractDigest: hash,
    dependencyCacheContentDigest: hash,
    dependencyCacheDigest: hash,
    dependencyReceiptDigest: hash,
    eligibilityDigest: hash,
    identityDigest: hash,
    imageDigest: hash,
    postTreeDigest: hash,
    preTreeDigest: hash,
    proposalDigest: hash,
    repositoryContractDigest: hash,
    sourceReceiptDigest: hash,
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    targetReceipt: {
      topology: { newDigest: hash, oldDigest: hash, path: "microfrontends.json" },
      version: 1 as const,
    },
    validationDigest: hash,
    version: 2 as const,
    workspaceDigest: hash,
  };
  return createReviewedChangeSetReceipt(
    { ...unsigned, digest: stableDigest(unsigned) },
    "review-call",
  );
};

describe("review receipt producer and publication verifier", () => {
  it("accepts the actual produced receipt after serialization", () => {
    const receipt = producedReceipt();
    const serialized: string = JSON.stringify(receipt);
    const parsed: unknown = JSON.parse(serialized);
    expect(parsed).toEqual(receipt);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Serialized reviewed receipt must be an object");
    }
    const verified = parsed as ReviewedChangeSetReceipt;
    assertExactReviewedChangeSet(verified);
  });
  it("still rejects changed review authority and content digests", () => {
    const receipt = producedReceipt();
    expect(() => {
      assertExactReviewedChangeSet({ ...receipt, reviewedByCallId: "different" });
    }).toThrow("outer reviewed");
    expect(() => {
      assertExactReviewedChangeSet({ ...receipt, changeSetDigest: "b".repeat(64) });
    }).toThrow("change-set digest");
    expect(() => {
      assertExactReviewedChangeSet({ ...receipt, approvedPaths: ["other"] });
    }).toThrow("approved paths");
  });
});
