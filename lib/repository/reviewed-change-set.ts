import { createHash } from "node:crypto";

import type { OverlayChange, TargetApplyReceipt } from "./target-apply";
import type { TargetValidationReceipt } from "./target-validation";

export type NormalizedChangeSet = {
  version: 2;
  validationDigest: string;
  applyDigest: string;
  proposalDigest: string;
  contractDigest: string;
  repositoryContractDigest: string;
  sourceSha: string;
  sourceTree: string;
  sourceReceiptDigest: string;
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

export function deriveNormalizedChangeSet(
  apply: TargetApplyReceipt,
  validation: TargetValidationReceipt,
  contractDigest: string,
  repositoryContractDigest: string = contractDigest,
): NormalizedChangeSet {
  const canonicalChanges = apply.changes;
  const unsigned = {
    version: 2 as const,
    validationDigest: validation.digest,
    applyDigest: apply.digest,
    proposalDigest: apply.proposalDigest,
    contractDigest,
    repositoryContractDigest,
    sourceSha: apply.sourceSha,
    sourceTree: apply.sourceTree,
    sourceReceiptDigest: apply.sourceReceiptDigest,
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
  const unsigned = {
    ...changeSet,
    changeSetDigest: changeSet.digest,
    reviewedByCallId,
  };
  return { ...unsigned, digest: digest(unsigned) };
}
