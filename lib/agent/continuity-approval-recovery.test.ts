/* oxlint-disable anti-slop/no-module-mocking -- Exercise read classification with the workflow runtime's error boundary replaced. */
import { expect, it, vi } from "vitest";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import { HostedSessionReadTimeoutError } from "../eve/hosted-session-read-timeout-error";
import { readContinuityApprovalWithRecovery } from "./continuity-approval-recovery";

vi.mock("workflow", () => ({
  RetryableError: class extends Error {
    override name = "RetryableError";
  },
}));

it("continues a partial native approval read without granting authority", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new HostedOperatorError("operator_unavailable"))
    .mockResolvedValueOnce({ approved: true });
  const { signal } = new AbortController();
  await expect(readContinuityApprovalWithRecovery(read, signal)).rejects.toThrow(
    "operator_unavailable",
  );
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
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    readContinuityApprovalWithRecovery(() => {
      controller.abort();
      return Promise.reject(new HostedOperatorError("operator_unavailable"));
    }, controller.signal),
  ).rejects.toThrow();
});

it("does not return authority from a successful read completed after cancellation", async () => {
  const controller = new AbortController();
  const result = Promise.withResolvers<{ approved: boolean }>();
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  const read = vi.fn(() => result.promise);
  const pending = readContinuityApprovalWithRecovery(read, controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  controller.abort();
  result.resolve({ approved: true });
  await rejected;
  expect(read).toHaveBeenCalledOnce();
});
it("does not read after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const read = vi.fn().mockResolvedValue({ approved: true });
  await expect(readContinuityApprovalWithRecovery(read, controller.signal)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it("keeps complete missing approval distinct from an unavailable read", async () => {
  await expect(
    readContinuityApprovalWithRecovery(
      vi.fn().mockResolvedValue({ approved: false }),
      new AbortController().signal,
    ),
  ).resolves.toEqual({ approved: false });
});
it("defers incomplete native history without treating it as permission to prompt again", async () => {
  await expect(
    readContinuityApprovalWithRecovery(
      vi.fn().mockRejectedValue(new HostedSessionReadTimeoutError()),
      new AbortController().signal,
    ),
  ).rejects.toThrow("approval_history_incomplete");
});
it("retains only closed operator failure facts in deferred errors", async () => {
  await expect(
    readContinuityApprovalWithRecovery(
      vi.fn().mockRejectedValue(
        new HostedOperatorError("operation_in_progress", {
          recoveryStage: "journal",
          cause: new Error("private-provider-detail"),
        }),
      ),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    message:
      "Continuity approval reconciliation must retry at journal: operation_in_progress. Preserve the same intent and native approval.",
    name: "RetryableError",
  });
});

it("continues every durably advancing native page without consuming the SDK retry budget", async () => {
  const read = vi.fn();
  for (let index = 0; index < 5; index += 1) {
    read.mockRejectedValueOnce(
      new HostedOperatorError("operator_unavailable", {
        recoveryStage: "native_history",
        recoveryProgressAdvanced: true,
      }),
    );
  }
  read.mockResolvedValueOnce({ approved: true });
  await expect(
    readContinuityApprovalWithRecovery(read, new AbortController().signal),
  ).resolves.toEqual({ approved: true });
  expect(read).toHaveBeenCalledTimes(6);
});
