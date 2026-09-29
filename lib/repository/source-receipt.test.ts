import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectCanonicalTemplateSnapshotReceipt,
  inspectExistingRepositorySnapshotReceipt,
  inspectSourceOnlyTemplateSnapshotReceipt,
  parseSourceReceipt,
  sourceIdentityDigest,
  sourceReceiptEvidence,
} from "./source-receipt";

const snapshot = {
  contents: {},
  contract: [],
  dirtyPaths: [],
  sourcePath: "/workspace/repository",
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("source receipt versions", () => {
  it.each([3, 4])("preserves the V%s persisted shape and digest", (version) => {
    const receipt =
      version === 3
        ? inspectExistingRepositorySnapshotReceipt(snapshot)
        : inspectCanonicalTemplateSnapshotReceipt({ readinessDigest: "c".repeat(64), snapshot });
    const evidence = sourceReceiptEvidence(receipt);
    const common = {
      adapter: receipt.adapter,
      contractDigest: receipt.contractDigest,
      eligibilityDigest: receipt.eligibilityDigest,
      releaseEnabled: false,
      sourceKind: receipt.sourceKind,
      sourceSha: snapshot.sourceSha,
      sourceTree: snapshot.sourceTree,
      version,
    };
    const persisted =
      version === 4
        ? {
            ...common,
            provenance: {
              method: "git-clone-v1",
              readinessDigest: "c".repeat(64),
              ref: "refs/heads/main",
              repository: "https://github.com/withAutograph/arrusted-development.git",
            },
          }
        : common;
    expect(evidence).toEqual({ ...persisted, digest: sha256(JSON.stringify(persisted)) });
    expect(parseSourceReceipt(structuredClone(receipt))).toEqual(receipt);
  });

  it("records V5 source identity without claiming readiness or requiring layout", () => {
    const receipt = inspectSourceOnlyTemplateSnapshotReceipt(snapshot);
    expect(receipt).toMatchObject({
      provenance: { sourceDigest: sourceIdentityDigest(snapshot.sourceSha, snapshot.sourceTree) },
      version: 5,
    });
    expect(receipt).not.toHaveProperty("provenance.readinessDigest");
    expect(parseSourceReceipt(structuredClone(receipt))).toEqual(receipt);
    if (receipt.version !== 5) {
      throw new Error("Expected source-only receipt");
    }
    expect(() =>
      parseSourceReceipt({
        ...receipt,
        provenance: {
          ...receipt.provenance,
          readinessDigest: "c".repeat(64),
        },
      }),
    ).toThrow();
    expect(() => parseSourceReceipt({ ...receipt, sourceSha: "d".repeat(40) })).toThrow();
  });
});
