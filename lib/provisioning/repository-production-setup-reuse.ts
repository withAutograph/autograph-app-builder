import { isDeepStrictEqual } from "node:util";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import { repositoryProductionOperationRef } from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import { repositoryProductionSetupComplete } from "./repository-production-setup";

interface PublishedSetupSubject {
  scope: RepositoryProductionScope;
  intent: RepositoryProductionIntent;
  publishedDescription?: boolean;
}

/** A new session can read ready setup for the same published effects and owner. */
export const canReuseCompletedRepositoryProductionSetup = ({
  owner,
  scope,
  row,
  current,
  isRuntimeBindingReady,
}: {
  owner: RepositoryProductionRequestOwner;
  scope: RepositoryProductionScope;
  row: RepositoryProductionRow;
  current: PublishedSetupSubject;
  isRuntimeBindingReady: (row: RepositoryProductionRow) => boolean;
}): boolean => {
  const { record } = row;
  const savedOwner = record.ownerContext;
  const approvedPlan = record.approval?.planDigest;
  const samePublishedSetup = [
    current.publishedDescription === true,
    owner.sessionId === owner.ownerContext.sessionId,
    owner.appId === scope.appId,
    current.intent.sessionId === owner.sessionId,
    isDeepStrictEqual(scope.authority, owner.ownerContext.authority),
    isDeepStrictEqual(current.scope, scope),
    isDeepStrictEqual(record.scope, scope),
    row.operationRef === repositoryProductionOperationRef(scope),
    savedOwner?.sessionId === record.intent.sessionId,
    isDeepStrictEqual(savedOwner?.authority, scope.authority),
  ].every(Boolean);
  if (
    !samePublishedSetup ||
    approvedPlan === undefined ||
    !repositoryProductionSetupComplete(record)
  ) {
    return false;
  }
  return (
    approvedPlan === repositoryProductionApprovalDigest(scope, record.intent) &&
    approvedPlan === repositoryProductionApprovalDigest(scope, current.intent) &&
    (record.intent.storage.kind === "none" || isRuntimeBindingReady(row))
  );
};
