import { isDeepStrictEqual } from "node:util";
import type { AppAccessOperationRow } from "../app-access/management";
import type { RepositoryProductionScope } from "./repository-production-contract";
import type {
  RepositoryProductionCompletion,
  RepositoryProductionRequestOwner,
} from "./repository-production-dispatcher";

export interface CompletedProductionInvitation {
  kind: "creator" | "invitee";
  invitationId: string;
  actorId: string;
  owner: RepositoryProductionRequestOwner;
  scope: RepositoryProductionScope;
}
export interface CompletionStatusPorts {
  readInvitee: (invitationId: string) => Promise<AppAccessOperationRow | undefined>;
  readCreator: (invitationId: string) => Promise<CompletedProductionInvitation | undefined>;
  assertAuthorized: (completed: CompletedProductionInvitation) => Promise<void>;
  readPending: (scope: RepositoryProductionScope) => Promise<readonly AppAccessOperationRow[]>;
}

const inviteeCompletion = (
  invitationId: string,
  row: AppAccessOperationRow,
): CompletedProductionInvitation | undefined => {
  const { record } = row;
  if (record.command.action !== "invite" || record.command.clientRequestId !== invitationId) {
    return undefined;
  }
  if (record.state !== "applied" || !record.dispatched) {
    return undefined;
  }
  if (record.enrollment?.state !== "applied" || record.enrollment.actorId.length === 0) {
    return undefined;
  }
  return {
    kind: "invitee",
    invitationId,
    actorId: record.enrollment.actorId,
    scope: record.scope,
    owner: {
      appId: record.scope.appId,
      sessionId: record.ownerContext.sessionId,
      ownerContext: record.ownerContext,
    },
  };
};

const conflictsWithCompletion = (
  completed: CompletedProductionInvitation,
  row: AppAccessOperationRow,
): boolean => {
  if (row.record.state !== "pending" || !isDeepStrictEqual(row.record.scope, completed.scope)) {
    return false;
  }
  const { command } = row.record;
  return command.action === "cancel"
    ? command.invitationId === completed.invitationId
    : (command.action === "remove" || command.action === "change-role") &&
        command.memberId === completed.actorId;
};

/** Acknowledges completed enrollment, never grants or proves current application access. */
export const createRepositoryProductionCompletionStatus = (ports: CompletionStatusPorts) => {
  const readCompleted = async (invitationId: string) => {
    const row = await ports.readInvitee(invitationId);
    const completed =
      row === undefined
        ? await ports.readCreator(invitationId)
        : inviteeCompletion(invitationId, row);
    return completed === undefined ? undefined : structuredClone(completed);
  };
  return async (invitationId: string): Promise<RepositoryProductionCompletion | undefined> => {
    const completed = await readCompleted(invitationId);
    if (completed === undefined) {
      return undefined;
    }
    await ports.assertAuthorized(completed);
    const pending = await ports.readPending(completed.scope);
    if (pending.some((row) => conflictsWithCompletion(completed, row))) {
      return "pending";
    }
    await ports.assertAuthorized(completed);
    const current = await readCompleted(invitationId);
    return isDeepStrictEqual(current, completed) ? "ready" : undefined;
  };
};

/** Observe durable completion before starting any mutation or its short response budget. */
export const completeRepositoryProductionFromStatus = async (
  readStatus: () => Promise<RepositoryProductionCompletion | undefined>,
  continuePending: () => Promise<RepositoryProductionCompletion>,
): Promise<RepositoryProductionCompletion> => {
  const status = await readStatus();
  return status ?? (await continuePending());
};
