import type { PrivateApplyDenialEvidence } from "../eve/private-apply-denial-evidence";
import { isDeepStrictEqual } from "node:util";
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
  terminalDecisions?: readonly (PrivateApplyDenialEvidence & { scope: PrivateApplyScope })[];
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
  { requiresUserApproval = true }: { requiresUserApproval?: boolean } = {},
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
  return !requiresUserApproval || sameScope(current.grant, scope) ? "approved" : "user-approval";
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
    ...current,
    grant: scope,
    pending: current.pending.filter((entry) => entry.callId !== callId),
  }));
};

/** A policy decision for another call or scope cannot authorize this execution. */
export const hasPendingPrivateApplyApproval = (
  scope: PrivateApplyScope,
  callId: string,
): boolean => {
  const pending = authority.get().pending.find((entry) => entry.callId === callId);
  return pending !== undefined && sameScope(pending.scope, scope);
};

/** A read-only prerequisite decision invalidates any older pending decision for that call. */
export const discardPendingPrivateApplyApproval = (callId: string): void => {
  const current = authority.get();
  if (current.pending.some((entry) => entry.callId === callId)) {
    authority.update(() => ({
      ...current,
      pending: current.pending.filter((entry) => entry.callId !== callId),
    }));
  }
};

/** Private build artifacts require the same actual Eve session and approved scope; no provider grant is implied. */
export const assertApprovedPrivateApplySession = (scope: PrivateApplyScope): void => {
  if (!sameScope(authority.get().grant, scope)) {
    throw new Error("Private artifact capture no longer belongs to this approved build session.");
  }
};

/** Pending approval decisions cannot be silently superseded by a new repair plan. */
export const assertNoPendingPrivateApplyApproval = (): void => {
  if (authority.get().pending.length !== 0) {
    throw new Error("Finish or reconcile the pending private Build approval before replanning.");
  }
};

/** Private authored consumers only: immutable pending bookkeeping, never a tool result. */
export const readPrivateApplyAuthority = () => structuredClone(authority.get());
/** Complete genuine framework denial retires bookkeeping, not approval or execution history. */
export const retainPrivateApplyDenials = (input: {
  expected: ReturnType<typeof readPrivateApplyAuthority>;
  proofs: readonly PrivateApplyDenialEvidence[];
}) => {
  const current = authority.get();
  if (!isDeepStrictEqual(current, input.expected)) {
    throw new Error("The private approval authority changed during history observation.");
  }
  const terminal = [...(current.terminalDecisions ?? [])];
  const retired = new Set<string>();
  const pendingByCall = new Map(current.pending.map((entry) => [entry.callId, entry]));
  const terminalByCall = new Map(terminal.map((entry) => [entry.callId, entry]));
  for (const proof of input.proofs) {
    const pending = pendingByCall.get(proof.callId);
    if (pending === undefined) {
      continue;
    }
    if (
      pending.scope.sessionId !== proof.sessionId ||
      !["denied-not-run", "ignored-not-run", "invalid-not-run"].includes(proof.outcome) ||
      proof.eventIds.length < 3
    ) {
      throw new Error("Private denial evidence belongs to another session or incomplete decision.");
    }
    const prior = terminalByCall.get(proof.callId);
    const value = { ...proof, scope: pending.scope };
    if (prior !== undefined && !isDeepStrictEqual(prior, value)) {
      throw new Error("Private approval terminal decision conflicts with retained evidence.");
    }
    if (prior === undefined) {
      terminal.push(value);
    }
    retired.add(proof.callId);
  }
  if (retired.size > 0) {
    authority.update(() => ({
      ...current,
      pending: current.pending.filter((entry) => !retired.has(entry.callId)),
      terminalDecisions: terminal,
    }));
  }
};
