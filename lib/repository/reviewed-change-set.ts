import { createHash } from "node:crypto";

import type { OverlayChange, TargetApplyReceipt } from "./target-apply";
import type { TargetValidationReceipt } from "./target-validation";

export interface NormalizedChangeSet {
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
}

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
  repositoryContractDigest: string = contractDigest
): NormalizedChangeSet {
  const canonicalChanges = apply.changes;
  const unsigned = {
    appSpecDigest: apply.appSpecDigest,
    appSpecPath: apply.appSpecPath,
    applyDigest: apply.digest,
    approvedPaths: canonicalChanges.map(({ path }) => path),
    artifactRevision: apply.artifactRevision,
    changedContentDigest: apply.changedContentDigest,
    changes: canonicalChanges,
    contractDigest,
    dependencyCacheContentDigest: apply.dependencyCacheContentDigest,
    dependencyCacheDigest: apply.dependencyCacheDigest,
    dependencyReceiptDigest: apply.dependencyReceiptDigest,
    eligibilityDigest: apply.eligibilityDigest,
    identityDigest: apply.identityDigest,
    imageDigest: apply.imageDigest,
    postTreeDigest: apply.postTreeDigest,
    preTreeDigest: apply.preTreeDigest,
    proposalDigest: apply.proposalDigest,
    repositoryContractDigest,
    sourceReceiptDigest: apply.sourceReceiptDigest,
    sourceSha: apply.sourceSha,
    sourceTree: apply.sourceTree,
    targetReceipt: {
      contractPath: apply.targetReceipt.contractPath,
      topology: apply.targetReceipt.topology,
      version: apply.targetReceipt.version,
    },
    validationDigest: validation.digest,
    version: 2 as const,
    workspaceDigest: apply.workspaceDigest,
  };
  return {
    ...unsigned,
    digest: digest(unsigned),
  };
}

export function createReviewedChangeSetReceipt(
  changeSet: NormalizedChangeSet,
  reviewedByCallId: string
): ReviewedChangeSetReceipt {
  const unsigned = {
    ...changeSet,
    changeSetDigest: changeSet.digest,
    reviewedByCallId,
  };
  return { ...unsigned, digest: digest(unsigned) };
}
