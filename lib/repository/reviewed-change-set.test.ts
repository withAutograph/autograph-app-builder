import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalOverlayFiles,
  type TargetApplyReceipt,
} from "./target-apply";
import type { TargetValidationReceipt } from "./target-validation";
import { ARRUSTED_APP_VALIDATION_SHA256 } from "./dependency-cache";
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
  sourceTree: "0".repeat(40),
  eligibilityDigest: digest("2"),
  workspaceDigest: digest("3"),
  appSpecDigest: acceptedAppSpecDigest,
  appSpecPath: "prototype/expense-review/app-spec.md",
  artifactRevision: digest("5"),
  dependencyReceiptDigest: digest("6"),
  identityDigest: digest("7"),
  imageDigest: `fixture@sha256:${digest("8")}`,
  dependencyCacheDigest: `sha256:${digest("9")}`,
  dependencyCacheContentDigest: digest("3"),
  proposalDigest: digest("a"),
  preTree,
  postTree,
  preparedTreeDigest: sha256(preTree),
  preTreeDigest: sha256(preTree),
  postTreeDigest: sha256(postTree),
  changedContentDigest: sha256(changes),
  changes: [...changes].reverse(),
  targetReceipt: {
    version: 1,
    appId: "example",
    contractPath: "apps/example/app.contract.json",
    topology: {
      path: "microfrontends.json",
      oldDigest: digest("a"),
      newDigest: digest("b"),
    },
  },
  digest: digest("0"),
} as unknown as TargetApplyReceipt;

const validation = {
  version: 3,
  status: "passed",
  appId: apply.targetReceipt.appId,
  testShards: ["1/1"],
  appValidationSha256: ARRUSTED_APP_VALIDATION_SHA256,
  sourceSha: apply.sourceSha,
  sourceTree: apply.sourceTree,
  eligibilityDigest: apply.eligibilityDigest,
  workspaceDigest: apply.workspaceDigest,
  appSpecDigest: apply.appSpecDigest,
  appSpecPath: apply.appSpecPath,
  artifactRevision: apply.artifactRevision,
  dependencyReceiptDigest: apply.dependencyReceiptDigest,
  identityDigest: apply.identityDigest,
  imageDigest: apply.imageDigest,
  dependencyCacheDigest: apply.dependencyCacheDigest,
  dependencyCacheContentDigest: apply.dependencyCacheContentDigest,
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

  it("uses the snapshot byte order for nested mixed-case paths", () => {
    const unchanged = [
      {
        path: ".codex/skills/harness-engineering-rules/agents/openai.yaml",
        mode: "644",
        digest: digest("a"),
      },
      {
        path: ".codex/skills/harness-engineering-rules/SKILL.md",
        mode: "644",
        digest: digest("b"),
      },
    ];
    const orderedPreTree = canonicalOverlayFiles([...preTree, ...unchanged]);
    const orderedPostTree = canonicalOverlayFiles([...postTree, ...unchanged]);
    const orderedApply = {
      ...apply,
      preTree: orderedPreTree,
      preTreeDigest: sha256(orderedPreTree),
      postTree: orderedPostTree,
      postTreeDigest: sha256(orderedPostTree),
    };
    const orderedValidation = {
      ...validation,
      appliedTreeDigest: orderedApply.postTreeDigest,
    };

    expect(orderedPostTree.slice(0, 2).map(({ path }) => path)).toEqual([
      ".codex/skills/harness-engineering-rules/SKILL.md",
      ".codex/skills/harness-engineering-rules/agents/openai.yaml",
    ]);
    expect(() =>
      deriveNormalizedChangeSet(
        orderedApply,
        orderedValidation,
        digest("2"),
      ),
    ).not.toThrow();
    expect(() =>
      deriveNormalizedChangeSet(
        {
          ...orderedApply,
          postTreeDigest: sha256(
            [...orderedPostTree].sort((left, right) =>
              left.path.localeCompare(right.path),
            ),
          ),
        },
        {
          ...orderedValidation,
          appliedTreeDigest: sha256(
            [...orderedPostTree].sort((left, right) =>
              left.path.localeCompare(right.path),
            ),
          ),
        },
        digest("2"),
      ),
    ).toThrow("canonical snapshot");
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
