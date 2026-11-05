import { describe, expect, it, vi } from "vitest";

import { createNativeRecoveryBinding } from "./native-recovery-binding";
import { hostedEveOperationScopes } from "./hosted-auth";
import {
  durableHostedSessionRecordSchema,
  hostedOperationRecordSchema,
  hostedSessionCreationDigest,
} from "./hosted-store";
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
  version: 1,
  operationId: "op_recovery",
  sourcePublicSessionId: "ses_parent",
  sourceOwnerRunId: "run_parent",
  sourceAdapterGeneration: 1,
  logicalSessionId: "run_parent",
  originalAuthoritySessionId: "ses_parent",
  parentCancellationRevision: 0,
};
const receipt: NativeRecoveryBinding = {
  ...descriptor,
  ownerRunId: "run_child",
  provenance: {
    kind: "completed-terminal-turn-input",
    sourceStepId: "step_1",
    sourceEventId: "event_1",
    sourceSlot: 0,
    checkpointVersion: 1,
  },
};

describe("native recovery authority", () => {
  it("reads and commits only the reserved failed source, then fences a changed cancellation revision", async () => {
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
    const operation = hostedOperationRecordSchema.parse({
      clientRequestId: "request_1",
      createdAtEpochMs: 3,
      kind: "start",
      nativeRecovery: descriptor,
      operationId: descriptor.operationId,
      principal,
      requestDigest: `sha256:${"a".repeat(64)}`,
      resumeSessionId: source.sessionId,
      state: "reserved",
      updatedAtEpochMs: 3,
      version: 1,
    });
    let current = source;
    let currentOperation = operation;
    let child: typeof source | null = null;
    let savedReceipt: NativeRecoveryBinding | undefined;
    // oxlint-disable-next-line eslint/require-await -- The test double follows the async store contract.
    const commitNativeRecoveryReceipt = vi.fn(async () => {
      savedReceipt = receipt;
      return receipt;
    });
    const canary = "private-auth-error-canary";
    let ownerError: Error | null = null;
    const assertOwner = vi.fn(() => {
      if (ownerError !== null) {
        throw ownerError;
      }
      return Promise.resolve();
    });
    const activationLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const binding = createNativeRecoveryBinding({
      assertOwner,
      now: () => 4,
      store: {
        commitNativeRecoveryReceipt,
        // oxlint-disable-next-line eslint/require-await -- The test double follows the async store contract.
        getPrivateOperation: async () => ({
          ...currentOperation,
          ...(savedReceipt === undefined ? {} : { nativeRecoveryReceipt: savedReceipt }),
        }),
        // oxlint-disable-next-line eslint/require-await -- The test double follows the async store contract.
        getSession: async (_principal, id) => (id === source.sessionId ? current : child),
      },
    });
    const call = { auth, descriptor };
    await expect(binding.readReceipt(call)).resolves.toBeNull();
    await expect(binding.commitReceipt({ ...call, recoveryBinding: receipt })).resolves.toEqual(
      receipt,
    );
    await expect(binding.readReceipt(call)).resolves.toEqual(receipt);
    expect(commitNativeRecoveryReceipt).toHaveBeenCalledTimes(1);
    expect(assertOwner).toHaveBeenCalledTimes(3);

    await expect(binding.authorizeActivation(call)).rejects.toThrow("not committed");
    child = durableHostedSessionRecordSchema.parse({
      ...source,
      adapterSessionId: receipt.ownerRunId,
      originAdapterSessionId: receipt.ownerRunId,
      nativeRecoveryBinding: receipt,
      parentSessionId: source.sessionId,
      sessionId: "ses_child",
      status: "working",
      resumability: "live",
      stage: "planning",
    });
    currentOperation = hostedOperationRecordSchema.parse({
      ...operation,
      state: "succeeded",
      nativeRecoveryReceipt: receipt,
      sessionId: child.sessionId,
      sessionRecordDigest: hostedSessionCreationDigest(child),
      result: { sessionId: child.sessionId, cursor: 0, events: [], status: "working" },
    });
    child = null;
    await expect(binding.authorizeActivation(call)).rejects.toThrow("unavailable");
    child = durableHostedSessionRecordSchema.parse({
      ...source,
      adapterSessionId: receipt.ownerRunId,
      originAdapterSessionId: receipt.ownerRunId,
      nativeRecoveryBinding: receipt,
      parentSessionId: "ses_other",
      sessionId: "ses_child",
      status: "working",
      resumability: "live",
      stage: "planning",
    });
    await expect(binding.authorizeActivation(call)).rejects.toThrow();
    child = durableHostedSessionRecordSchema.parse({ ...child, parentSessionId: source.sessionId });
    await expect(binding.authorizeActivation(call)).resolves.toBeUndefined();
    const originalChild = child;
    child = durableHostedSessionRecordSchema.parse({
      ...originalChild,
      cancellationRevision: 1,
      status: "cancelled",
    });
    await expect(binding.authorizeActivation(call)).rejects.toThrow("cancelled");
    child = durableHostedSessionRecordSchema.parse({
      ...originalChild,
      cancellationRevision: 1,
      resumedCancellationRevision: 1,
    });
    await expect(binding.authorizeActivation(call)).resolves.toBeUndefined();
    child = durableHostedSessionRecordSchema.parse({ ...child, cancellationRevision: 2 });
    await expect(binding.authorizeActivation(call)).rejects.toThrow("cancelled");
    child = originalChild;
    current = durableHostedSessionRecordSchema.parse({ ...source, cancellationRevision: 1 });
    await expect(binding.authorize(call)).rejects.toThrow("ownership changed");
    await expect(binding.authorizeActivation(call)).rejects.toThrow("ownership changed");
    current = source;
    activationLog.mockImplementationOnce(() => {
      throw new Error(canary);
    });
    await expect(binding.authorizeActivation(call)).resolves.toBeUndefined();
    ownerError = new Error(canary);
    await expect(binding.authorizeActivation(call)).rejects.toThrow(canary);

    const stages = [
      "committed_operation",
      "child_lookup_principal",
      "child_receipt_authority",
      "authorized",
      "child_cancellation",
      "authorized",
      "child_cancellation",
      "source_authorization",
      "authorized",
      "source_authorization",
    ];
    expect(activationLog.mock.calls).toEqual(
      stages.map((stage) => [
        JSON.stringify({
          event: "builder.native_recovery_activation",
          outcome: stage === "authorized" ? "authorized" : "failed",
          stage,
        }),
      ]),
    );
    expect(JSON.stringify(activationLog.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(activationLog.mock.calls)).not.toContain(descriptor.operationId);
    activationLog.mockRestore();
  });
});

describe("read-only native source observation authority", () => {
  it("uses GET authority without creating a recovery reservation and rejects coordinate changes", async () => {
    const source = durableHostedSessionRecordSchema.parse({
      adapterGeneration: 1,
      adapterSessionId: "run_parent",
      createdAtEpochMs: 1,
      lastProgressAtEpochMs: 1,
      stage: "needs_attention",
      title: "App",
      originAdapterSessionId: "run_parent",
      principal,
      resumability: "live",
      sessionId: "ses_parent",
      status: "input_required",
      updatedAtEpochMs: 2,
      version: 2,
    });
    const getPrivateOperation = vi.fn(() => Promise.resolve(null));
    const commitNativeRecoveryReceipt = vi.fn(() => Promise.resolve(receipt));
    const assertOwner = vi.fn(() => Promise.resolve());
    const binding = createNativeRecoveryBinding({
      assertOwner,
      store: {
        getSession: () => Promise.resolve(source),
        getPrivateOperation,
        commitNativeRecoveryReceipt,
      },
    });
    const coordinates = {
      sourcePublicSessionId: "ses_parent",
      sourceAdapterSessionId: "run_parent",
      sourceAdapterGeneration: 1,
      cancellationRevision: 0,
    };
    const getOnlyAuth = {
      ...auth,
      attributes: { ...auth.attributes, "mcp:scopes": [hostedEveOperationScopes.get] },
    };
    await expect(
      binding.authorizeSourceObservation({ auth: getOnlyAuth, source: coordinates }),
    ).resolves.toEqual({ ownerRunId: "run_parent", logicalSessionId: "run_parent" });
    for (const changed of [
      { ...coordinates, sourceAdapterGeneration: 2 },
      { ...coordinates, cancellationRevision: 1 },
      { ...coordinates, sourceAdapterSessionId: "different" },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential exact-coordinate authorization refusal checks.
      await expect(binding.authorizeSourceObservation({ auth, source: changed })).rejects.toThrow(
        "changed",
      );
    }
    assertOwner.mockRejectedValueOnce(new Error("owner revoked"));
    await expect(binding.authorizeSourceObservation({ auth, source: coordinates })).rejects.toThrow(
      "owner revoked",
    );
    expect(getPrivateOperation).not.toHaveBeenCalled();
    expect(commitNativeRecoveryReceipt).not.toHaveBeenCalled();
  });
});
