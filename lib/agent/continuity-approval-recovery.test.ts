import { expect, it, vi } from "vitest";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import { readContinuityApprovalWithRecovery } from "./continuity-approval-recovery";

it("continues a partial native approval read without granting authority", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new HostedOperatorError("operator_unavailable"))
    .mockResolvedValueOnce({ approved: true });
  const signal = new AbortController().signal;
  expect(await readContinuityApprovalWithRecovery(read, signal)).toEqual({ approved: false });
  expect(await readContinuityApprovalWithRecovery(read, signal)).toEqual({ approved: true });
});
it("does not retry an owner denial or unclassified failure", async () => {
  await Promise.all(
    [new HostedOperatorError("authorization_required"), new Error("unknown")].map(async (error) => {
      await expect(
        readContinuityApprovalWithRecovery(
          vi.fn().mockRejectedValue(error),
          new AbortController().signal,
        ),
      ).rejects.toBe(error);
    }),
  );
});
it("respects cancellation during a failed read", async () => {
  const controller = new AbortController();
  await expect(
    readContinuityApprovalWithRecovery(() => {
      controller.abort();
      return Promise.reject(new HostedOperatorError("operator_unavailable"));
    }, controller.signal),
  ).rejects.toThrow();
});
