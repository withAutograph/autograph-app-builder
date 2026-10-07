import { afterEach, expect, it, vi } from "vitest";
import { holdActiveCommandLease } from "./active-command-lease";

afterEach(() => {
  vi.useRealTimers();
});

it("renews a long active command before the observed five-minute expiry and stops when finished", async () => {
  vi.useFakeTimers();
  const target = {
    expiresAt: new Date(Date.now() + 300_000),
    extendTimeout: vi.fn(async (duration: number) => {
      target.expiresAt = new Date(target.expiresAt.getTime() + duration);
      await Promise.resolve();
    }),
  };
  const authorize = vi.fn(async () => {
    await Promise.resolve();
  });
  const lease = await holdActiveCommandLease({ authorize, current: () => target });
  expect(target.extendTimeout).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(240_000);
  expect(target.extendTimeout).toHaveBeenCalledOnce();
  expect(target.extendTimeout.mock.calls[0]?.[0]).toBe(300_000);
  expect(authorize).toHaveBeenCalledOnce();
  await lease.finish();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(target.extendTimeout).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("renews the currently owned reattached handle", async () => {
  vi.useFakeTimers();
  const previous = {
    expiresAt: new Date(Date.now() + 300_000),
    extendTimeout: vi.fn(async () => {
      await Promise.resolve();
    }),
  };
  const reattached = {
    expiresAt: new Date(Date.now() + 20_000),
    extendTimeout: vi.fn(async () => {
      await Promise.resolve();
    }),
  };
  let current = previous;
  const lease = await holdActiveCommandLease({ current: () => current });
  current = reattached;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(previous.extendTimeout).not.toHaveBeenCalled();
  expect(reattached.extendTimeout).toHaveBeenCalledOnce();
  await lease.finish();
});

it("aborts command authority when a provider renewal fails", async () => {
  vi.useFakeTimers();
  const target = {
    expiresAt: new Date(Date.now() + 75_000),
    extendTimeout: vi.fn().mockRejectedValue(new Error("provider renewal failed")),
  };
  const lease = await holdActiveCommandLease({ current: () => target });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(lease.signal.aborted).toBe(true);
  expect(lease.signal.reason).toMatchObject({ message: "provider renewal failed" });
  await lease.finish();
  expect(vi.getTimerCount()).toBe(0);
});

it("stops renewal immediately on caller cancellation", async () => {
  vi.useFakeTimers();
  const target = {
    expiresAt: new Date(Date.now() + 300_000),
    extendTimeout: vi.fn(async () => {
      await Promise.resolve();
    }),
  };
  const caller = new AbortController();
  const lease = await holdActiveCommandLease({ current: () => target, signal: caller.signal });
  caller.abort(new Error("caller stopped"));
  expect(lease.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(target.extendTimeout).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await lease.finish();
});
