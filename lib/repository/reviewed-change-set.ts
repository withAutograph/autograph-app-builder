import { createHash } from "node:crypto";

import {
  assertCurrentTargetApplyReceipt,
  overlayChanges,
  type OverlayChange,
  type OverlayFile,
  type OverlaySnapshot,
  type TargetApplyReceipt,
} from "./target-apply";
import { safeSourcePath } from "./source-path";
import type { TargetValidationReceipt } from "./target-validation";
import { ARRUSTED_APP_VALIDATION_SHA256 } from "./dependency-cache";
import { SUPPORTED_VALIDATION_TEST_SHARDS } from "./supported-template";

export type NormalizedChangeSet = {
  version: 2;
  validationDigest: string;
  applyDigest: string;
  proposalDigest: string;
  contractDigest: string;
  repositoryContractDigest: string;
  sourceSha: string;
  sourceTree: string;
  eligibilityDigest: string;
  workspaceDigest: string;
  appSpecDigest: string;
  appSpecPath: string;
  artifactRevision: string;
  dependencyReceiptDigest: string;
  identityDigest: string;
  imageDigest: string;
  dependencyCacheDigest: string;
  dependencyCacheContentDigest: string;
  targetReceipt: {
    version: 1;
    contractPath: string;
    topology: { path: string; oldDigest: string; newDigest: string };
  };
  preTreeDigest: string;
  postTreeDigest: string;
  changedContentDigest: string;
  changes: readonly OverlayChange[];
  approvedPaths: readonly string[];
  digest: string;
};

export type ReviewedChangeSetReceipt = NormalizedChangeSet & {
  changeSetDigest: string;
  reviewedByCallId: string;
  digest: string;
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function normalizedChanges(
  changes: readonly OverlayChange[],
): readonly OverlayChange[] {
  const paths = new Set<string>();
  for (const change of changes) {
    if (!safeSourcePath(change.path))
      throw new Error("The applied change set contains an unsafe path.");
    if (paths.has(change.path))
      throw new Error("The applied change set contains a duplicate path.");
    paths.add(change.path);
    const validFile = (
      file: unknown,
    ): file is { mode: string; digest: string } =>
      typeof file === "object" &&
      file !== null &&
      "mode" in file &&
      typeof file.mode === "string" &&
      /^[0-7]{3,4}$/u.test(file.mode) &&
      "digest" in file &&
      typeof file.digest === "string" &&
      /^[0-9a-f]{64}$/u.test(file.digest);
    if (
      (change.kind === "added" &&
        (change.before !== undefined || !validFile(change.after))) ||
      (change.kind === "deleted" &&
        (!validFile(change.before) || change.after !== undefined)) ||
      (change.kind === "modified" &&
        (!validFile(change.before) || !validFile(change.after))) ||
      (change.kind !== "added" &&
        change.kind !== "deleted" &&
        change.kind !== "modified")
    )
      throw new Error(
        "The applied change set contains an invalid change record.",
      );
  }
  return [...changes].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function normalizedSnapshot(files: readonly OverlayFile[]): OverlaySnapshot {
  const paths = new Set<string>();
  const normalized = files.map((file) => {
    if (
      !safeSourcePath(file.path) ||
      !/^[0-7]{3,4}$/u.test(file.mode) ||
      !/^[0-9a-f]{64}$/u.test(file.digest) ||
      paths.has(file.path)
    )
      throw new Error("The applied tree receipt is malformed.");
    paths.add(file.path);
    return { path: file.path, mode: file.mode, digest: file.digest };
  });
  normalized.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { files: normalized, treeDigest: digest(normalized) };
}

export function deriveNormalizedChangeSet(
  apply: TargetApplyReceipt,
  validation: TargetValidationReceipt,
  contractDigest: string,
  repositoryContractDigest: string = contractDigest,
): NormalizedChangeSet {
  assertCurrentTargetApplyReceipt(apply);
  if (
    validation.version !== 3 ||
    validation.status !== "passed" ||
    validation.applyDigest !== apply.digest ||
    validation.appliedTreeDigest !== apply.postTreeDigest ||
    validation.changedContentDigest !== apply.changedContentDigest
  )
    throw new Error(
      "A passed validation receipt for the exact apply is required.",
    );
  const exactValidationBinding = {
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
  };
  if (
    validation.appId !== apply.targetReceipt.appId ||
    JSON.stringify(validation.testShards) !==
      JSON.stringify(SUPPORTED_VALIDATION_TEST_SHARDS) ||
    validation.appValidationSha256 !== ARRUSTED_APP_VALIDATION_SHA256 ||
    Object.entries(exactValidationBinding).some(
      ([key, value]) =>
        validation[key as keyof typeof exactValidationBinding] !== value,
    )
  )
    throw new Error(
      "The validation receipt bindings differ from the exact apply receipt.",
    );
  if (
    !/^[0-9a-f]{64}$/u.test(contractDigest) ||
    !/^[0-9a-f]{64}$/u.test(repositoryContractDigest)
  )
    throw new Error("The planned or repository contract digest is invalid.");
  const before = normalizedSnapshot(apply.preTree);
  const after = normalizedSnapshot(apply.postTree);
  if (
    before.treeDigest !== apply.preTreeDigest ||
    after.treeDigest !== apply.postTreeDigest
  )
    throw new Error(
      "The applied tree receipt does not match its canonical snapshot.",
    );
  const changes = normalizedChanges(apply.changes);
  const canonicalChanges = overlayChanges(before, after);
  if (JSON.stringify(changes) !== JSON.stringify(canonicalChanges))
    throw new Error(
      "The applied change set does not match its canonical overlay diff.",
    );
  if (digest(canonicalChanges) !== apply.changedContentDigest)
    throw new Error("The applied change set content digest is stale.");
  const unsigned = {
    version: 2 as const,
    validationDigest: validation.digest,
    applyDigest: apply.digest,
    proposalDigest: apply.proposalDigest,
    contractDigest,
    repositoryContractDigest,
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
    targetReceipt: {
      version: apply.targetReceipt.version,
      contractPath: apply.targetReceipt.contractPath,
      topology: apply.targetReceipt.topology,
    },
    preTreeDigest: apply.preTreeDigest,
    postTreeDigest: apply.postTreeDigest,
    changedContentDigest: apply.changedContentDigest,
    changes: canonicalChanges,
    approvedPaths: canonicalChanges.map(({ path }) => path),
  };
  return {
    ...unsigned,
    digest: digest(unsigned),
  };
}

export function createReviewedChangeSetReceipt(
  changeSet: NormalizedChangeSet,
  reviewedByCallId: string,
): ReviewedChangeSetReceipt {
  if (
    changeSet.version !== 2 ||
    !safeSourcePath(changeSet.appSpecPath) ||
    !/^[0-9a-f]{64}$/u.test(changeSet.appSpecDigest)
  )
    throw new Error("A canonical V2 normalized change set is required.");
  const unsigned = {
    ...changeSet,
    changeSetDigest: changeSet.digest,
    reviewedByCallId,
  };
  return { ...unsigned, digest: digest(unsigned) };
}
