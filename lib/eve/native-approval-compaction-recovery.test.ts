/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Actual private SDK values remain inside the controlled native fixture. */
import { expect, it } from "vitest";
import { retainedPrivateApplyRecoveryFixture as fixture } from "./native-private-apply-recovery.test-fixture";
import { call, originalUser, execute } from "./native-approval-compaction.test-fixture";

it("the real collector/reconciler restores the genuine approved response from the retained bad tail without a new approval or fabricated result", async () => {
  const f = await fixture();
  expect(f.repeatableCallIds).toEqual([call.toolCallId]);
  expect(f.reconciled.kind).toBe("ready");
  const restored = f.readDurableSession(f.reconciled.checkpointCore.sessionState);
  expect(f.reconciled.checkpointCore.serializedContext).toEqual(f.context);
  expect(
    restored.history.filter(
      (message: { role: string; content: unknown }) =>
        message.role === "user" && message.content === originalUser.content,
    ),
  ).toHaveLength(1);
  expect(await execute(restored.history)).toHaveBeenCalledOnce();
});
it("a foreign pending proposal cannot authorize recovery of that call", async () => {
  const f = await fixture(true);
  expect(f.repeatableCallIds).toEqual([]);
  if (f.reconciled.kind === "ready") {
    expect(
      await execute(f.readDurableSession(f.reconciled.checkpointCore.sessionState).history),
    ).not.toHaveBeenCalled();
  }
});
