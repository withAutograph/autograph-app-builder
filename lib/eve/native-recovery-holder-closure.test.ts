import { describe, expect, it } from "vitest";

import { createNativeRecoveryBinding } from "./native-recovery-binding";
import { hostedEveOperationScopes } from "./hosted-auth";
import {
  durableHostedSessionRecordSchema,
  hostedOperationRecordSchema,
  hostedSessionCreationDigest,
} from "./hosted-store";
import type { HostedOperationRecord, HostedSessionRecord } from "./hosted-store";
import type { NativeRecoveryBinding, NativeRecoveryDescriptor } from "./native-recovery-contract";

const principal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "closure-owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "closure-workspace",
};
const auth = {
  attributes: {
    "mcp:audience": principal.audience,
    "mcp:scopes": principal.scopes,
    "mcp:workspace-id": principal.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: principal.issuer,
  principalId: principal.ownerUserId,
  principalType: "user",
  subject: principal.ownerUserId,
};
const holderDescriptor: NativeRecoveryDescriptor = {
  version: 1,
  operationId: "op_older_recovery",
  sourcePublicSessionId: "ses_origin",
  sourceOwnerRunId: "run_logical",
  sourceAdapterGeneration: 1,
  logicalSessionId: "run_logical",
  originalAuthoritySessionId: "ses_origin",
  parentCancellationRevision: 0,
};
const winnerReceipt: NativeRecoveryBinding = {
  ...holderDescriptor,
  ownerRunId: "run_accepted_winner",
  provenance: {
    kind: "failed-turn-input",
    sourceStepId: "retained-step",
    sourceEventId: "retained-event",
    sourceSlot: 0,
    checkpointVersion: 1,
  },
};
const origin = durableHostedSessionRecordSchema.parse({
  adapterGeneration: 1,
  adapterSessionId: holderDescriptor.sourceOwnerRunId,
  cancellationRevision: 0,
  createdAtEpochMs: 1,
  lastProgressAtEpochMs: 2,
  originAdapterSessionId: holderDescriptor.sourceOwnerRunId,
  principal,
  resumability: "terminal",
  sessionId: holderDescriptor.sourcePublicSessionId,
  stage: "needs_attention",
  status: "failed",
  title: "Retained app",
  updatedAtEpochMs: 2,
  version: 2,
});
const winner = durableHostedSessionRecordSchema.parse({
  ...origin,
  adapterSessionId: winnerReceipt.ownerRunId,
  nativeRecoveryBinding: winnerReceipt,
  originAdapterSessionId: winnerReceipt.ownerRunId,
  parentSessionId: origin.sessionId,
  resumedCancellationRevision: 0,
  sessionId: "ses_accepted_winner",
});
const descriptor: NativeRecoveryDescriptor = {
  ...holderDescriptor,
  operationId: "op_current_recovery",
  sourcePublicSessionId: winner.sessionId,
  sourceOwnerRunId: winner.adapterSessionId,
};
const operation = (recovery: NativeRecoveryDescriptor): HostedOperationRecord =>
  hostedOperationRecordSchema.parse({
    clientRequestId: `request_${recovery.operationId}`,
    createdAtEpochMs: 3,
    kind: "start",
    nativeRecovery: recovery,
    operationId: recovery.operationId,
    principal,
    requestDigest: `sha256:${"c".repeat(64)}`,
    resumeSessionId: recovery.sourcePublicSessionId,
    state: "reserved",
    updatedAtEpochMs: 3,
    version: 1,
  });
const holderOperation = hostedOperationRecordSchema.parse({
  ...operation(holderDescriptor),
  nativeRecoveryReceipt: winnerReceipt,
  result: { sessionId: winner.sessionId, cursor: 0, events: [], status: "failed" },
  sessionId: winner.sessionId,
  sessionRecordDigest: hostedSessionCreationDigest(winner),
  state: "succeeded",
});
const call = {
  auth,
  descriptor,
  holderDescriptor,
  holderHookId: "hook_parked_candidate",
  holderOwnerRunId: "run_parked_candidate",
};

const fixture = () => {
  const operations = new Map<string, HostedOperationRecord>([
    [descriptor.operationId, operation(descriptor)],
    [holderDescriptor.operationId, holderOperation],
  ]);
  const sessions = new Map<string, HostedSessionRecord>([
    [origin.sessionId, origin],
    [winner.sessionId, winner],
  ]);
  let allowed = true;
  let onRead: ((operationId: string) => void) | undefined;
  const binding = createNativeRecoveryBinding({
    assertOwner: () => {
      if (!allowed) {
        throw new Error("closure-current-owner-revoked");
      }
      return Promise.resolve();
    },
    store: {
      getPrivateOperation: (_principal, operationId) => {
        onRead?.(operationId);
        return Promise.resolve(operations.get(operationId) ?? null);
      },
      getSession: (_principal, sessionId) => Promise.resolve(sessions.get(sessionId) ?? null),
    },
  });
  return {
    binding,
    operations,
    sessions,
    revoke: () => {
      allowed = false;
    },
    onRead: (effect: (operationId: string) => void) => {
      onRead = effect;
    },
  };
};

describe("fresh authorization to close an immutable recovery loser", () => {
  it("authorizes only the parked physical candidate while preserving the accepted operation", async () => {
    const f = fixture();
    const beforeOperations = [...f.operations.entries()];
    const beforeSessions = [...f.sessions.entries()];
    await expect(f.binding.authorizeRecoveryHolderClosure(call)).resolves.toEqual({
      kind: "immutable-loser",
      winnerOwnerRunId: winnerReceipt.ownerRunId,
    });
    expect([...f.operations.entries()]).toEqual(beforeOperations);
    expect([...f.sessions.entries()]).toEqual(beforeSessions);
  });

  it("refuses the actual accepted physical owner", async () => {
    const f = fixture();
    await expect(
      f.binding.authorizeRecoveryHolderClosure({
        ...call,
        holderOwnerRunId: winnerReceipt.ownerRunId,
      }),
    ).rejects.toThrow();
  });

  it.each(["reserved", "submission_unknown", "rejected"] as const)(
    "does not infer nonexecution from a %s holder without a committed winner",
    async (state) => {
      const f = fixture();
      f.operations.set(
        holderDescriptor.operationId,
        hostedOperationRecordSchema.parse({
          ...operation(holderDescriptor),
          ...(state === "reserved" ? {} : { safeErrorCode: "unknown" }),
          state,
        }),
      );
      await expect(f.binding.authorizeRecoveryHolderClosure(call)).rejects.toThrow();
    },
  );

  it.each(["operation", "source", "winner"] as const)(
    "refuses a missing %s instead of treating absence as cleanup authority",
    async (kind) => {
      const f = fixture();
      if (kind === "operation") {
        f.operations.delete(holderDescriptor.operationId);
      }
      if (kind === "source") {
        f.sessions.delete(origin.sessionId);
      }
      if (kind === "winner") {
        f.sessions.delete(winner.sessionId);
      }
      await expect(f.binding.authorizeRecoveryHolderClosure(call)).rejects.toThrow();
    },
  );

  it.each(["operation", "source", "winner"] as const)(
    "refuses another principal's %s even if its identifiers match",
    async (kind) => {
      const f = fixture();
      const foreignPrincipal = { ...principal, ownerUserId: "unrelated-owner" };
      if (kind === "operation") {
        f.operations.set(
          holderDescriptor.operationId,
          hostedOperationRecordSchema.parse({
            ...holderOperation,
            principal: foreignPrincipal,
          }),
        );
      } else {
        const record = kind === "source" ? origin : winner;
        f.sessions.set(
          record.sessionId,
          durableHostedSessionRecordSchema.parse({
            ...record,
            principal: foreignPrincipal,
          }),
        );
      }
      await expect(f.binding.authorizeRecoveryHolderClosure(call)).rejects.toThrow();
    },
  );

  it.each([
    { logicalSessionId: "unrelated-logical" },
    { originalAuthoritySessionId: "unrelated-authority" },
  ])("refuses mismatched logical or original authority lineage (%j)", async (changed) => {
    const f = fixture();
    await expect(
      f.binding.authorizeRecoveryHolderClosure({
        ...call,
        holderDescriptor: { ...holderDescriptor, ...changed },
      }),
    ).rejects.toThrow();
  });

  it("requires the exact retained descriptor and canonical winner receipt", async () => {
    const f = fixture();
    await expect(
      f.binding.authorizeRecoveryHolderClosure({
        ...call,
        holderDescriptor: { ...holderDescriptor, sourceAdapterGeneration: 2 },
      }),
    ).rejects.toThrow();
    expect(() =>
      hostedOperationRecordSchema.parse({
        ...holderOperation,
        nativeRecoveryReceipt: { ...winnerReceipt, sourceOwnerRunId: "wrong-source" },
      }),
    ).toThrow();
  });

  it("requires the winner child to retain its canonical receipt and physical identity", async () => {
    const f = fixture();
    f.sessions.set(
      winner.sessionId,
      durableHostedSessionRecordSchema.parse({
        ...winner,
        nativeRecoveryBinding: { ...winnerReceipt, ownerRunId: "another-winner" },
      }),
    );
    await expect(f.binding.authorizeRecoveryHolderClosure(call)).rejects.toThrow();
  });

  it.each(["current-stop", "origin-stop", "winner-cancelled"] as const)(
    "refuses %s under current cancellation fences",
    async (kind) => {
      const f = fixture();
      if (kind === "origin-stop") {
        f.sessions.set(
          origin.sessionId,
          durableHostedSessionRecordSchema.parse({
            ...origin,
            cancellationRevision: 1,
            status: "cancelled",
          }),
        );
      } else {
        f.sessions.set(
          winner.sessionId,
          durableHostedSessionRecordSchema.parse({
            ...winner,
            cancellationRevision: kind === "current-stop" ? 1 : 0,
            status: kind === "winner-cancelled" ? "cancelled" : "failed",
          }),
        );
      }
      await expect(f.binding.authorizeRecoveryHolderClosure(call)).rejects.toThrow();
    },
  );

  it("rechecks current ownership after reading the older operation", async () => {
    const f = fixture();
    f.onRead((operationId) => {
      if (operationId === holderDescriptor.operationId) {
        f.revoke();
      }
    });
    await expect(f.binding.authorizeRecoveryHolderClosure(call)).rejects.toThrow(
      "closure-current-owner-revoked",
    );
  });

  it("refuses cleanup after the current request obtains a receipt", async () => {
    const f = fixture();
    f.operations.set(
      descriptor.operationId,
      hostedOperationRecordSchema.parse({
        ...operation(descriptor),
        nativeRecoveryReceipt: { ...winnerReceipt, ...descriptor, ownerRunId: "current-winner" },
      }),
    );
    await expect(f.binding.authorizeRecoveryHolderClosure(call)).rejects.toThrow();
  });

  it("requires the current authenticated principal rather than the retained entry's identity", async () => {
    const f = fixture();
    await expect(
      f.binding.authorizeRecoveryHolderClosure({
        ...call,
        auth: { ...auth, principalId: "foreign-owner", subject: "foreign-owner" },
      }),
    ).rejects.toThrow();
  });
});
