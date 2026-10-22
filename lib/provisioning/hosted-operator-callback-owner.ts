import type { HostedEveStore } from "../eve/hosted-store";
import { hostedSessionRecordSchema, toDurableHostedSessionRecord } from "../eve/hosted-store";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";

/** Private runtime evidence. Never populated from a model input or an approval receipt. */
export interface HostedOperatorCallbackExecution {
  readonly logicalSessionId: string;
  readonly ownerRunId?: string;
  readonly ownerAnchorRunId?: string;
}

export type HostedOperatorCallbackStore = Pick<HostedEveStore, "getSession"> &
  Partial<Pick<HostedEveStore, "readCurrentBuildSession">>;

/** Read only the framework's live callback projection, never checkpoint or model input fields. */
export const hostedOperatorCallbackExecution = (session: {
  readonly id: string;
  readonly ownerRunId?: string;
  readonly ownerAnchorRunId?: string;
}): HostedOperatorCallbackExecution => ({
  logicalSessionId: session.id,
  ownerRunId: session.ownerRunId,
  ownerAnchorRunId: session.ownerAnchorRunId,
});

const samePrincipal = (left: HostedPrincipal, right: HostedPrincipal) =>
  (["issuer", "audience", "workspaceId", "ownerUserId"] as const).every(
    (key) => left[key] === right[key],
  ) && JSON.stringify([...left.scopes].toSorted()) === JSON.stringify([...right.scopes].toSorted());

const denied = () => new HostedOperatorError("authorization_required");

const recoveredCallbackMatches = (input: {
  authoritySession: ReturnType<typeof toDurableHostedSessionRecord>;
  currentSession: ReturnType<typeof toDurableHostedSessionRecord>;
  execution?: HostedOperatorCallbackExecution;
  logicalSessionId: string;
  canReadCurrent: boolean;
}) => {
  const binding = input.currentSession.nativeRecoveryBinding;
  return [
    input.canReadCurrent,
    binding !== undefined,
    binding?.originalAuthoritySessionId === input.authoritySession.sessionId,
    binding?.logicalSessionId === input.logicalSessionId,
    binding?.ownerRunId === input.currentSession.adapterSessionId,
    input.execution?.ownerRunId !== undefined && input.execution.ownerRunId.length > 0,
    input.execution?.ownerAnchorRunId === input.currentSession.adapterSessionId,
  ].every(Boolean);
};

/** Keep immutable human receipts separate from the committed current execution owner. */
export const readHostedOperatorCallbackSessions = async (input: {
  store: HostedOperatorCallbackStore;
  owner: OperatorOwnerContext;
  execution?: HostedOperatorCallbackExecution;
}) => {
  const raw = await input.store.getSession(input.owner.principal, input.owner.sessionId);
  if (raw === null) {
    throw denied();
  }
  const authoritySession = toDurableHostedSessionRecord(hostedSessionRecordSchema.parse(raw));
  if (
    authoritySession.sessionId !== input.owner.sessionId ||
    !samePrincipal(authoritySession.principal, input.owner.principal)
  ) {
    throw denied();
  }
  const logicalSessionId = input.execution?.logicalSessionId ?? authoritySession.adapterSessionId;
  const currentSession =
    (await input.store.readCurrentBuildSession?.({
      authoritySessionId: authoritySession.sessionId,
      logicalSessionId,
      principal: input.owner.principal,
    })) ?? authoritySession;
  const currentMatches = [
    samePrincipal(currentSession.principal, input.owner.principal),
    currentSession.sourceHandoffId === authoritySession.sourceHandoffId,
    currentSession.appId === authoritySession.appId,
    currentSession.status !== "cancelled",
    currentSession.status !== "completed",
    (currentSession.cancellationRevision ?? 0) ===
      (currentSession.resumedCancellationRevision ?? 0),
    currentSession.sessionId !== authoritySession.sessionId ||
      logicalSessionId === authoritySession.adapterSessionId,
    currentSession.sessionId !== authoritySession.sessionId ||
      input.execution?.ownerAnchorRunId === undefined ||
      input.execution.ownerAnchorRunId === authoritySession.adapterSessionId,
  ].every(Boolean);
  if (!currentMatches) {
    throw denied();
  }
  if (currentSession.sessionId !== authoritySession.sessionId) {
    const recoveryMatches = recoveredCallbackMatches({
      authoritySession,
      currentSession,
      execution: input.execution,
      logicalSessionId,
      canReadCurrent: input.store.readCurrentBuildSession !== undefined,
    });
    if (!recoveryMatches) {
      throw denied();
    }
  }
  return { authoritySession, currentSession };
};

/** Recheck the frozen operator projection, including current Stop, on every readback wake. */
export const readHostedOperatorCallbackOwner = async (input: {
  store: HostedOperatorCallbackStore;
  owner: OperatorOwnerContext;
  execution?: HostedOperatorCallbackExecution;
}) => {
  const sessions = await readHostedOperatorCallbackSessions(input);
  if (
    sessions.currentSession.adapterSessionId !== input.owner.adapterSessionId ||
    sessions.currentSession.adapterGeneration !== input.owner.adapterGeneration
  ) {
    throw denied();
  }
  return sessions;
};
