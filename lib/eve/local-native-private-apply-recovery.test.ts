/* oxlint-disable sonarjs/publicly-writable-directories -- Disposable native authority fixtures are owner-only and removed after each case. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Real private SDK collector/reconciler values remain inside the controlled fixture; no public or provider input is trusted. */
import { mkdtemp, chmod, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client, ClientSession } from "eve/client";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalNativeRecovery } from "./local-native-recovery";
import { nativeRecoveryBindingSchema } from "./native-recovery-contract";
import { retainedPrivateApplyRecoveryFixture } from "./native-private-apply-recovery.test-fixture";
import { call, execute } from "./native-approval-compaction.test-fixture";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "builder-local-private-apply-")));
  roots.push(root);
  await chmod(root, 0o700);
  const cycle = path.join(root, "cycle");
  await writeFile(cycle, "a".repeat(64), { mode: 0o600 });
  const recovery = createLocalNativeRecovery({
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    EVE_HOSTED_ADAPTER: "0",
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: cycle,
  });
  if (recovery === undefined) {
    throw new Error("Missing local authority fixture");
  }
  const publicId = "same-saved-session";
  const native = await retainedPrivateApplyRecoveryFixture(false, {
    ownerRunId: publicId,
    logicalSessionId: publicId,
  });
  vi.spyOn(ClientSession.prototype, "snapshot").mockImplementation(
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    function snapshot(this: ClientSession) {
      return Promise.resolve({
        session: { sessionId: this.state.sessionId, streamIndex: 1 },
        events: [
          {
            type: "session.failed" as const,
            data: {
              code: "MODEL_CALL_FAILED",
              message: "Controlled unresolved approved private apply",
              sessionId: this.state.sessionId,
            },
            meta: { id: "failed", at: "2026-11-04T07:14:18.000Z" },
          },
        ],
      });
    },
  );
  const client = new Client({ host: "http://127.0.0.1:49999" });
  const auth = {
    authenticator: "local-dev",
    principalId: "local-dev",
    principalType: "local-dev",
    attributes: { "eve:forwarded-by": "local-dev" },
  };
  type Request = Parameters<Parameters<typeof recovery.recover>[3]>[0];
  let reserved: Request | undefined;
  await expect(
    recovery.recover(client, publicId, "known-rejected-preparation", async (body) => {
      reserved = body;
      await recovery.ports.authorize({ auth, descriptor: body.recovery });
      // The previously absent local callback provided no authorized calls.
      const rejected = await native.reconcile([]);
      expect(rejected).toMatchObject({ kind: "uncertain", reason: "uncommitted-action-dispatch" });
      throw new Error("Known rejected preparation; no child accepted");
    }),
  ).rejects.toThrow("Known rejected preparation");
  if (reserved === undefined) {
    throw new Error("Missing genuine local reservation");
  }
  const authorizeCalls = recovery.ports.authorizeRepeatableRecoveryCalls?.bind(recovery.ports);
  if (authorizeCalls === undefined) {
    throw new Error("The local private-apply recovery policy is not wired");
  }
  const request = reserved;
  const policy = async (payload = native.payload, binding = native.binding, selectedAuth = auth) =>
    (await authorizeCalls({
      auth: selectedAuth,
      descriptor: request.recovery,
      payload,
      binding,
    })) ?? [];
  return { auth, client, native, policy, publicId, recovery, request };
};
it("uses the real local authority ports to recover the original exact private call after a known rejected preparation", async () => {
  const f = await fixture();
  expect(f.recovery.lineage(f.publicId)).toEqual([f.publicId]);
  expect(await f.policy()).toEqual([call.toolCallId]);
  let restored: Parameters<typeof execute>[0] | undefined;
  const post = vi.fn(async (body: Parameters<Parameters<typeof f.recovery.recover>[3]>[0]) => {
    // New public CID reconciles the same immutable source reservation.
    expect(body.recovery).toEqual(f.request.recovery);
    const input = { auth: f.auth, descriptor: body.recovery };
    await f.recovery.ports.authorize(input);
    if (body.recoveryPhase === "activate") {
      await f.recovery.ports.authorizeActivation(input);
      const receipt = nativeRecoveryBindingSchema.parse(await f.recovery.ports.readReceipt(input));
      return { sessionId: receipt.ownerRunId, recoveryBinding: receipt };
    }
    const allowed = await f.policy();
    const result = await f.native.reconcile(allowed);
    expect(result.kind).toBe("ready");
    restored = f.native.readDurableSession(result.checkpointCore.sessionState).history;
    const source = result.provenance.selectedOrigin;
    const receipt = nativeRecoveryBindingSchema.parse({
      ...body.recovery,
      ownerRunId: "recovered-owned-executor",
      provenance: {
        kind: source.kind,
        sourceStepId: source.stepId,
        sourceEventId: source.eventId,
        sourceSlot: source.slot,
        checkpointOwnerRunId: result.provenance.checkpointOwnerRunId,
        checkpointVersion: 1,
      },
    });
    await f.recovery.ports.commitReceipt({ ...input, recoveryBinding: receipt });
    return { sessionId: receipt.ownerRunId, recoveryBinding: receipt };
  });
  await f.recovery.recover(f.client, f.publicId, "new-qualified-recovery-cid", post);
  expect(post).toHaveBeenCalledTimes(2);
  expect(f.recovery.lineage(f.publicId)).toEqual([f.publicId, "recovered-owned-executor"]);
  if (restored === undefined) {
    throw new Error("Missing genuine reconciled transcript");
  }
  // SDK execution follows the genuine reconciled transcript; no fabricated output is appended.
  expect(await execute(restored)).toHaveBeenCalledOnce();
});
it("keeps foreign pending proposals and outward calls in strict native reconciliation", async () => {
  const f = await fixture();
  const foreign = await retainedPrivateApplyRecoveryFixture(true, f.native.binding);
  expect(await f.policy(foreign.payload)).toEqual([]);
  const outward = structuredClone(f.native.payload);
  for (const candidate of outward.candidates) {
    for (const message of candidate.sessionState.snapshot.session.history) {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type === "tool-call") {
          part.toolName = "prepare-app-native-target";
        }
      }
    }
  }
  expect(await f.policy(outward)).toEqual([]);
  expect(await f.native.reconcile([])).toMatchObject({
    kind: "uncertain",
    reason: "uncommitted-action-dispatch",
  });
});
it("requires the current local principal, exact source binding and uncancelled reservation", async () => {
  const f = await fixture();
  await expect(
    f.policy(f.native.payload, f.native.binding, { ...f.auth, principalId: "another-user" }),
  ).rejects.toThrow("unavailable");
  expect(
    await f.policy(f.native.payload, { ...f.native.binding, ownerRunId: "another-owner" }),
  ).toEqual([]);
  await f.recovery.cancel(f.publicId);
  await expect(f.policy()).rejects.toThrow("unavailable");
});
