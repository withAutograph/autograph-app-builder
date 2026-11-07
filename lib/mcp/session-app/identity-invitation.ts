import type { EveSessionResult, PublicIdentityInvitation } from "../contracts";

export interface IdentityInvitationState {
  sessionId: string;
  lastIndex: number;
  invitations: PublicIdentityInvitation[];
}

const invitationKey = (invitation: Pick<PublicIdentityInvitation, "callId" | "operationRef">) =>
  invitation.operationRef === undefined
    ? `call:${invitation.callId}`
    : `setup:${invitation.operationRef}`;

/** Retain pending invitations across delta reads, ignoring already observed public events. */
export const reduceIdentityInvitations = (
  previous: IdentityInvitationState | undefined,
  result: EveSessionResult,
): IdentityInvitationState => {
  const state =
    previous?.sessionId === result.sessionId
      ? previous
      : { sessionId: result.sessionId, lastIndex: -1, invitations: [] };
  const invitations = new Map(
    state.invitations.map((invitation) => [invitationKey(invitation), invitation]),
  );
  let { lastIndex } = state;
  for (const event of result.events) {
    if (event.index <= state.lastIndex) {
      continue;
    }
    lastIndex = Math.max(lastIndex, event.index);
    if (event.type === "auth_identity_invitation") {
      const { callId, url, expiresAt, operationRef } = event;
      invitations.set(invitationKey(event), {
        callId,
        url,
        expiresAt,
        ...(operationRef === undefined ? {} : { operationRef }),
      });
    } else if (event.type === "auth_identity_invitation_resolved") {
      invitations.delete(invitationKey(event));
    }
  }
  if (["completed", "failed", "cancelled"].includes(result.status)) {
    invitations.clear();
  }
  return { sessionId: result.sessionId, lastIndex, invitations: [...invitations.values()] };
};
