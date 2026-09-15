import { defineState } from "eve/context";

export interface PrivateApplyScope {
  appId: string;
  appSpecDigest: string;
  proposalDigest: string;
  sessionId: string;
  workspaceId: string;
}
interface PendingPrivateApply {
  callId: string;
  scope: PrivateApplyScope;
}
interface PrivateApplyAuthority {
  grant: PrivateApplyScope | null;
  pending: PendingPrivateApply[];
}
const authority = defineState<PrivateApplyAuthority>(
  "autograph-app-builder.private-apply-authority.v1",
  () => ({ grant: null, pending: [] }),
);
const sameScope = (left: PrivateApplyScope | null, right: PrivateApplyScope): boolean => {
  if (left === null) {
    return false;
  }
  const sameProduct =
    left.appId === right.appId &&
    left.appSpecDigest === right.appSpecDigest &&
    left.proposalDigest === right.proposalDigest;
  return (
    sameProduct && left.sessionId === right.sessionId && left.workspaceId === right.workspaceId
  );
};

/** Eve calls this before approval; pending scope is not an authorization grant. */
export const requestPrivateApplyApproval = (
  scope: PrivateApplyScope,
  callId: string,
): "approved" | "user-approval" => {
  const current = authority.get();
  const pending = current.pending.find((entry) => entry.callId === callId);
  if (pending && !sameScope(pending.scope, scope)) {
    throw new Error(
      "The pending build approval belongs to a different proposal or private target.",
    );
  }
  if (!pending) {
    authority.update(() => ({ ...current, pending: [...current.pending, { callId, scope }] }));
  }
  return sameScope(current.grant, scope) ? "approved" : "user-approval";
};

/** Only call from the approved tool execution, before implementation checks that may throw. */
export const recordApprovedPrivateApply = (scope: PrivateApplyScope, callId: string): void => {
  const current = authority.get();
  const pending = current.pending.find((entry) => entry.callId === callId);
  if (!pending && sameScope(current.grant, scope)) {
    return;
  }
  if (!pending || !sameScope(pending.scope, scope)) {
    throw new Error("The build approval no longer matches the current proposal or private target.");
  }
  authority.update(() => ({
    grant: scope,
    pending: current.pending.filter((entry) => entry.callId !== callId),
  }));
};
