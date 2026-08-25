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
const acceptedAppSpec = Buffer.from("# Accepted AppSpec\n");
const acceptedAppSpecDigest = createHash("sha256")
  .update(acceptedAppSpec)
  .digest("hex");

const preTree = [
  { path: "apps/a/package.json", mode: "644", digest: digest("e") },
];
const postTree = [
  { path: "apps/a/package.json", mode: "644", digest: digest("f") },
  { path: "apps/z/package.json", mode: "644", digest: digest("d") },
  {
    path: "prototype/example/app-spec.md",
    mode: "644",
    digest: acceptedAppSpecDigest,
  },
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
  {
    path: "prototype/example/app-spec.md",
    kind: "added" as const,
    after: { mode: "644", digest: acceptedAppSpecDigest },
  },
];

const apply = {
  version: 2,
  sourceSha: "1".repeat(40),
  eligibilityDigest: digest("2"),
  workspaceDigest: digest("3"),
  appSpecDigest: acceptedAppSpecDigest,
  appSpecPath: "prototype/expense-review/app-spec.md",
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
  version: 2,
  status: "passed",
  sourceSha: apply.sourceSha,
  eligibilityDigest: apply.eligibilityDigest,
  workspaceDigest: apply.workspaceDigest,
  appSpecDigest: apply.appSpecDigest,
  appSpecPath: apply.appSpecPath,
  artifactRevision: apply.artifactRevision,
  dependencyReceiptDigest: apply.dependencyReceiptDigest,
  identityDigest: apply.identityDigest,
  imageDigest: apply.imageDigest,
  dependencyCacheDigest: apply.dependencyCacheDigest,
  proposalDigest: apply.proposalDigest,
  applyDigest: apply.digest,
  appliedTreeDigest: apply.postTreeDigest,
  changedContentDigest: apply.changedContentDigest,
  digest: digest("1"),
} as unknown as TargetValidationReceipt;

describe("reviewed change-set receipts", () => {
  it("rejects historical and wrong-version runtime receipts before review", () => {
    const historicalApply = { ...apply, version: 1 } as Record<string, unknown>;
    delete historicalApply.appSpecPath;
    expect(() =>
      deriveNormalizedChangeSet(
        historicalApply as never,
        validation,
        digest("2"),
      ),
    ).toThrow(/canonical V2 target apply receipt/u);
    expect(() =>
      deriveNormalizedChangeSet(
        { ...apply, version: 1 } as never,
        validation,
        digest("2"),
      ),
    ).toThrow(/canonical V2 target apply receipt/u);
    expect(() =>
      deriveNormalizedChangeSet(
        apply,
        { ...validation, version: 1 } as never,
        digest("2"),
      ),
    ).toThrow(/passed validation receipt/u);
  });

  it("rejects validation bindings that differ from the exact apply", () => {
    expect(() =>
      deriveNormalizedChangeSet(
        apply,
        { ...validation, appSpecPath: "prototype/other/app-spec.md" } as never,
        digest("2"),
      ),
    ).toThrow(/bindings differ/u);
  });
  it("normalizes the exact validated apply changes and its approved paths", () => {
    const proposal = deriveNormalizedChangeSet(apply, validation, digest("2"));
    expect(proposal.changes.map(({ path }) => path)).toEqual([
      "apps/a/package.json",
      "apps/z/package.json",
      "prototype/example/app-spec.md",
    ]);
    expect(proposal.approvedPaths).toEqual([
      "apps/a/package.json",
      "apps/z/package.json",
      "prototype/example/app-spec.md",
    ]);
    expect(proposal).toMatchObject({
      eligibilityDigest: apply.eligibilityDigest,
      appSpecDigest: apply.appSpecDigest,
      appSpecPath: apply.appSpecPath,
      artifactRevision: apply.artifactRevision,
      targetReceipt: { contractPath: apply.targetReceipt.contractPath },
    });
    expect(
      proposal.changes.find(
        ({ path }) => path === "prototype/example/app-spec.md",
      ),
    ).toEqual({
      path: "prototype/example/app-spec.md",
      kind: "added",
      after: { mode: "644", digest: acceptedAppSpecDigest },
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
