import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { TargetApplyReceipt } from "./target-apply";
import type { TargetValidationReceipt } from "./target-validation";
import {
  createReviewedChangeSetReceipt,
  deriveNormalizedChangeSet,
} from "./reviewed-change-set";

const digest = (character: string) => character.repeat(64).slice(0, 64);
const sha256 = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const preTree = [
  { path: "apps/a/package.json", mode: "644", digest: digest("e") },
];
const postTree = [
  { path: "apps/a/package.json", mode: "644", digest: digest("f") },
  { path: "apps/z/package.json", mode: "644", digest: digest("d") },
];
const changes = [
  {
    path: "apps/a/package.json",
    kind: "modified" as const,
    before: { mode: "644", digest: digest("e") },
    after: { mode: "644", digest: digest("f") },
  },
  {
    path: "apps/z/package.json",
    kind: "added" as const,
    after: { mode: "644", digest: digest("d") },
  },
];

const apply = {
  sourceSha: "1".repeat(40),
  eligibilityDigest: digest("2"),
  workspaceDigest: digest("3"),
  appSpecDigest: digest("4"),
  artifactRevision: digest("5"),
  dependencyReceiptDigest: digest("6"),
  identityDigest: digest("7"),
  imageDigest: `fixture@sha256:${digest("8")}`,
  dependencyCacheDigest: `sha256:${digest("9")}`,
  proposalDigest: digest("a"),
  preTree,
  postTree,
  preTreeDigest: sha256(preTree),
  postTreeDigest: sha256(postTree),
  changedContentDigest: sha256(changes),
  changes: [...changes].reverse(),
  targetReceipt: {
    version: 1,
    contractPath: "apps/example/app.contract.json",
    topology: {
      path: "apps/shell/microfrontends.json",
      oldDigest: digest("a"),
      newDigest: digest("b"),
    },
  },
  digest: digest("0"),
} as unknown as TargetApplyReceipt;

const validation = {
  status: "passed",
  applyDigest: apply.digest,
  appliedTreeDigest: apply.postTreeDigest,
  changedContentDigest: apply.changedContentDigest,
  digest: digest("1"),
} as unknown as TargetValidationReceipt;

describe("reviewed change-set receipts", () => {
  it("normalizes the exact validated apply changes and its approved paths", () => {
    const proposal = deriveNormalizedChangeSet(apply, validation, digest("2"));
    expect(proposal.changes.map(({ path }) => path)).toEqual([
      "apps/a/package.json",
      "apps/z/package.json",
    ]);
    expect(proposal.approvedPaths).toEqual([
      "apps/a/package.json",
      "apps/z/package.json",
    ]);
    expect(proposal).toMatchObject({
      eligibilityDigest: apply.eligibilityDigest,
      appSpecDigest: apply.appSpecDigest,
      artifactRevision: apply.artifactRevision,
      targetReceipt: { contractPath: apply.targetReceipt.contractPath },
    });
    const receipt = createReviewedChangeSetReceipt(proposal, "review-call");
    expect(receipt).toMatchObject({
      changeSetDigest: proposal.digest,
      reviewedByCallId: "review-call",
    });
    expect(createReviewedChangeSetReceipt(proposal, "review-call")).toEqual(
      receipt,
    );
  });

  it("fails closed for duplicate, unsafe, or non-exact validated changes", () => {
    expect(() =>
      deriveNormalizedChangeSet(
        { ...apply, changes: [...apply.changes, apply.changes[0]!] },
        validation,
        digest("2"),
      ),
    ).toThrow("duplicate path");
    expect(() =>
      deriveNormalizedChangeSet(
        { ...apply, changes: [{ path: "../escape", kind: "added" }] },
        validation,
        digest("2"),
      ),
    ).toThrow("unsafe path");
    expect(() =>
      deriveNormalizedChangeSet(
        apply,
        { ...validation, appliedTreeDigest: digest("f") },
        digest("2"),
      ),
    ).toThrow("exact apply");
    expect(() =>
      deriveNormalizedChangeSet(
        {
          ...apply,
          changes: [
            {
              ...changes[0]!,
              after: { mode: "not-a-mode", digest: digest("f") },
            },
            changes[1]!,
          ],
        },
        validation,
        digest("2"),
      ),
    ).toThrow("invalid change record");
    expect(() =>
      deriveNormalizedChangeSet(
        {
          ...apply,
          changes: [
            { ...changes[0]!, kind: "renamed" as "modified" },
            changes[1]!,
          ],
        },
        validation,
        digest("2"),
      ),
    ).toThrow("invalid change record");
    expect(() =>
      deriveNormalizedChangeSet(
        {
          ...apply,
          changes: [
            {
              ...changes[0]!,
              after: { mode: "644", digest: "not-a-digest" },
            },
            changes[1]!,
          ],
        },
        validation,
        digest("2"),
      ),
    ).toThrow("invalid change record");
    expect(() =>
      deriveNormalizedChangeSet(
        { ...apply, changedContentDigest: digest("a") },
        { ...validation, changedContentDigest: digest("a") },
        digest("2"),
      ),
    ).toThrow("content digest is stale");
    expect(() =>
      deriveNormalizedChangeSet(apply, validation, "not-a-digest"),
    ).toThrow("contract digest is invalid");
  });
});
