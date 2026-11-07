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
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
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
const descriptor: NativeRecoveryDescriptor = {
  logicalSessionId: "run_parent",
  operationId: "op_current",
  originalAuthoritySessionId: "ses_parent",
  parentCancellationRevision: 0,
  sourceAdapterGeneration: 1,
  sourceOwnerRunId: "run_parent",
  sourcePublicSessionId: "ses_parent",
  version: 1,
};
const holderDescriptor: NativeRecoveryDescriptor = {
  ...descriptor,
  operationId: "op_holder",
};
const holderReceipt: NativeRecoveryBinding = {
  ...holderDescriptor,
  ownerRunId: "run_holder",
  provenance: {
    checkpointVersion: 1,
    kind: "completed-terminal-turn-input",
    sourceEventId: "event_1",
    sourceSlot: 0,
    sourceStepId: "step_1",
  },
};

const source = durableHostedSessionRecordSchema.parse({
  adapterGeneration: 1,
  adapterSessionId: "run_parent",
  createdAtEpochMs: 1,
  lastProgressAtEpochMs: 2,
  originAdapterSessionId: "run_parent",
  principal,
  resumability: "terminal",
  sessionId: "ses_parent",
  stage: "needs_attention",
  status: "failed",
  title: "App",
  updatedAtEpochMs: 2,
  version: 2,
});
const reserved = (nativeRecovery: NativeRecoveryDescriptor): HostedOperationRecord =>
  hostedOperationRecordSchema.parse({
    clientRequestId: `request_${nativeRecovery.operationId}`,
    createdAtEpochMs: 3,
    kind: "start",
    nativeRecovery,
    operationId: nativeRecovery.operationId,
    principal,
    requestDigest: `sha256:${"a".repeat(64)}`,
    resumeSessionId: nativeRecovery.sourcePublicSessionId,
    state: "reserved",
    updatedAtEpochMs: 3,
    version: 1,
  });

const fixture = () => {
  let currentSource: HostedSessionRecord = source;
  let allowed = true;
  const operations = new Map<string, HostedOperationRecord>([
    [descriptor.operationId, reserved(descriptor)],
    [holderDescriptor.operationId, reserved(holderDescriptor)],
  ]);
  const sessions = new Map<string, HostedSessionRecord>([[source.sessionId, source]]);
  const binding = createNativeRecoveryBinding({
    assertOwner: async () => {
      if (!allowed) {
        throw new Error("current-owner-revoked");
      }
    },
    store: {
      // oxlint-disable-next-line eslint/require-await -- The in-memory read follows the store's asynchronous port.
      getPrivateOperation: async (_principal, operationId) => operations.get(operationId) ?? null,
      // oxlint-disable-next-line eslint/require-await -- The in-memory read follows the store's asynchronous port.
      getSession: async (_principal, sessionId) =>
        sessionId === source.sessionId ? currentSource : (sessions.get(sessionId) ?? null),
    },
  });
  return {
    binding,
    operations,
    revoke: () => {
      allowed = false;
    },
    sessions,
    setSource: (next: HostedSessionRecord) => {
      currentSource = next;
    },
  };
};
const call = {
  auth,
  descriptor,
  holderDescriptor,
  holderOwnerRunId: holderReceipt.ownerRunId,
};

describe("native recovery holder facts", () => {
  it("classifies another reserved logical-inbox owner's exact source without claiming it", async () => {
    const f = fixture();
    await expect(f.binding.observeRecoveryHolderBinding(call)).resolves.toEqual({
      committedChildMatches: null,
      descriptorMatches: true,
      operationFound: true,
      operationRejected: false,
      operationReserved: true,
      operationSubmissionUnknown: false,
      operationSucceeded: false,
      receiptOwnerMatches: null,
      receiptPresent: false,
      sourceBound: true,
      sourceCancellationMatches: true,
      sourceCancelled: false,
    });
  });

  it.each(["submission_unknown", "rejected"] as const)(
    "keeps a %s holder operation distinct from a committed receipt",
    async (state) => {
      const f = fixture();
      f.operations.set(
        holderDescriptor.operationId,
        hostedOperationRecordSchema.parse({
          ...reserved(holderDescriptor),
          safeErrorCode: "unknown",
          state,
        }),
      );
      const facts = await f.binding.observeRecoveryHolderBinding(call);
      expect(facts.operationSubmissionUnknown).toBe(state === "submission_unknown");
      expect(facts.operationRejected).toBe(state === "rejected");
      expect(facts.operationSucceeded).toBe(false);
      expect(facts.receiptPresent).toBe(false);
      expect(facts.committedChildMatches).toBeNull();
    },
  );

  it("confirms only a succeeded holder with its own exact receipt and committed child", async () => {
    const f = fixture();
    const child = durableHostedSessionRecordSchema.parse({
      ...source,
      adapterSessionId: holderReceipt.ownerRunId,
      nativeRecoveryBinding: holderReceipt,
      originAdapterSessionId: holderReceipt.ownerRunId,
      parentSessionId: source.sessionId,
      resumability: "live",
      sessionId: "ses_holder_child",
      stage: "planning",
      status: "working",
    });
    f.sessions.set(child.sessionId, child);
    f.operations.set(
      holderDescriptor.operationId,
      hostedOperationRecordSchema.parse({
        ...reserved(holderDescriptor),
        nativeRecoveryReceipt: holderReceipt,
        result: { cursor: 0, events: [], sessionId: child.sessionId, status: "working" },
        sessionId: child.sessionId,
        sessionRecordDigest: hostedSessionCreationDigest(child),
        state: "succeeded",
      }),
    );
    const facts = await f.binding.observeRecoveryHolderBinding(call);
    expect(facts).toMatchObject({
      committedChildMatches: true,
      operationReserved: false,
      operationSucceeded: true,
      receiptOwnerMatches: true,
      receiptPresent: true,
      sourceBound: true,
    });
    const wrongOwner = await f.binding.observeRecoveryHolderBinding({
      ...call,
      holderOwnerRunId: "different-physical-owner",
    });
    expect(wrongOwner.receiptOwnerMatches).toBe(false);
    expect(wrongOwner.committedChildMatches).toBeNull();
  });

  it("rejects foreign lineage and current Stop or owner changes before reading holder facts", async () => {
    const f = fixture();
    await expect(
      f.binding.observeRecoveryHolderBinding({
        ...call,
        holderDescriptor: { ...holderDescriptor, originalAuthoritySessionId: "ses_foreign" },
      }),
    ).rejects.toThrow("lineage");
    f.setSource(durableHostedSessionRecordSchema.parse({ ...source, cancellationRevision: 1 }));
    await expect(f.binding.observeRecoveryHolderBinding(call)).rejects.toThrow("ownership changed");
    f.setSource(source);
    f.revoke();
    await expect(f.binding.observeRecoveryHolderBinding(call)).rejects.toThrow(
      "current-owner-revoked",
    );
  });

  it("keeps missing and unrelated holder operations unknown", async () => {
    const f = fixture();
    f.operations.delete(holderDescriptor.operationId);
    expect(await f.binding.observeRecoveryHolderBinding(call)).toMatchObject({
      descriptorMatches: null,
      operationFound: false,
      receiptPresent: null,
      sourceBound: null,
    });
    f.operations.set(
      holderDescriptor.operationId,
      reserved({
        ...holderDescriptor,
        sourceOwnerRunId: "another-source-owner",
      }),
    );
    expect(await f.binding.observeRecoveryHolderBinding(call)).toMatchObject({
      descriptorMatches: false,
      operationFound: true,
      receiptPresent: null,
      sourceBound: null,
    });
  });

  it.each(["missing", "foreign", "cancelled"] as const)(
    "reports a %s holder source without borrowing current source authority",
    async (kind) => {
      const f = fixture();
      const retainedDescriptor = {
        ...holderDescriptor,
        sourcePublicSessionId: "ses_holder_source",
      };
      f.operations.set(holderDescriptor.operationId, reserved(retainedDescriptor));
      if (kind !== "missing") {
        f.sessions.set(
          retainedDescriptor.sourcePublicSessionId,
          durableHostedSessionRecordSchema.parse({
            ...source,
            cancellationRevision: kind === "cancelled" ? 1 : 0,
            principal:
              kind === "foreign" ? { ...principal, ownerUserId: "foreign-owner" } : principal,
            sessionId: retainedDescriptor.sourcePublicSessionId,
            status: kind === "cancelled" ? "cancelled" : "failed",
          }),
        );
      }
      expect(
        await f.binding.observeRecoveryHolderBinding({
          ...call,
          holderDescriptor: retainedDescriptor,
        }),
      ).toMatchObject({
        committedChildMatches: null,
        descriptorMatches: true,
        operationFound: true,
        receiptPresent: false,
        sourceBound: false,
        sourceCancellationMatches: kind === "cancelled" ? false : null,
        sourceCancelled: kind === "cancelled" ? true : null,
      });
    },
  );

  it("requires the current forwarded principal before inspecting holder operations", async () => {
    const f = fixture();
    await expect(
      f.binding.observeRecoveryHolderBinding({
        ...call,
        auth: { ...auth, principalId: "foreign-owner", subject: "foreign-owner" },
      }),
    ).rejects.toThrow("owner is unavailable");
  });

  it("never classifies another principal's private operation as this holder", async () => {
    const f = fixture();
    f.operations.set(
      holderDescriptor.operationId,
      hostedOperationRecordSchema.parse({
        ...reserved(holderDescriptor),
        principal: { ...principal, ownerUserId: "another-owner" },
      }),
    );
    await expect(f.binding.observeRecoveryHolderBinding(call)).resolves.toEqual({
      committedChildMatches: null,
      descriptorMatches: null,
      operationFound: false,
      operationRejected: null,
      operationReserved: null,
      operationSubmissionUnknown: null,
      operationSucceeded: null,
      receiptOwnerMatches: null,
      receiptPresent: null,
      sourceBound: null,
      sourceCancellationMatches: null,
      sourceCancelled: null,
    });
  });
});
