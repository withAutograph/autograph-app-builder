import { isDeepStrictEqual } from "node:util";
import type { HostedDatabase } from "../db/hosted-postgres";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import { createPostgresOperatorApprovalCheckpoint } from "./postgres-operator-approval-checkpoint";
import type { RepositoryProductionApprovalInput } from "./repository-production-approval";

const unavailable = () => new Error("repository_production_approval_unavailable");

export const createRepositoryProductionApprovalCheckpoint = (input: {
  database: HostedDatabase;
  plan: RepositoryProductionApprovalInput;
  owner: OperatorOwnerContext;
  callId: string;
  directGrantDigest?: string;
  assertCurrentOwner: () => Promise<void>;
}) => {
  const { plan, owner } = input;
  if (
    plan.intent.sessionId !== owner.sessionId ||
    !isDeepStrictEqual(plan.scope.authority, owner.authority)
  ) {
    throw unavailable();
  }
  return createPostgresOperatorApprovalCheckpoint({
    ...input,
    kind: "repository-production-approval-observation",
    key: JSON.stringify([
      "repository-production-approval-v1",
      owner.sessionId,
      plan.operationRef,
      plan.planDigest,
      input.callId,
      input.directGrantDigest ?? null,
    ]),
    request: {
      action: "repository-production",
      planRef: plan.operationRef,
      planDigest: plan.planDigest,
      idempotencyKey: plan.scope.appId,
    },
    unavailable,
  });
};
