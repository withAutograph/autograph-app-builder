import { expect, it, vi } from "vitest";

import { GitHubPrEffectRejectedError } from "./github-pr-delivery";
import type { GitHubPrDeliveryObservation } from "./github-pr-delivery";
import {
  executeApprovedGitHubPrEffect,
  reconcileApprovedGitHubPrEffect,
} from "./github-pr-effect-executor";
import type { GitHubPrEffectIntent, GitHubPrEffectReceipt } from "./github-pr-effect-journal";

const readyAt = "2026-11-05T15:30:00Z";
const newerReadyAt = "2026-11-05T15:45:00Z";
const readyIntent = {
  baseBranch: "main",
  headSha: "c".repeat(40),
  installationIdentityDigest: "b".repeat(64),
  kind: "pr-ready",
  name: "app",
  owner: "withAutograph",
  publicationDigest: "a".repeat(64),
  pullRequestNumber: 12,
  repositoryId: "100",
} satisfies GitHubPrEffectIntent;
const mergeIntent = { ...readyIntent, kind: "pr-merge", readyAt } satisfies GitHubPrEffectIntent;
const draft: GitHubPrDeliveryObservation = {
  baseBranch: readyIntent.baseBranch,
  checks: "pending",
  draft: true,
  headSha: readyIntent.headSha,
  state: "open",
};
const ready: GitHubPrDeliveryObservation = { ...draft, draft: false, readyAt };
const passed: GitHubPrDeliveryObservation = { ...ready, checkRunId: 42, checks: "passed" };
const merged: GitHubPrDeliveryObservation = {
  ...passed,
  mergeCommitSha: "d".repeat(40),
  state: "merged",
};

const fixture = (initial: GitHubPrDeliveryObservation, onClaim?: () => void) => {
  const rows = new Map<string, GitHubPrEffectReceipt>();
  const store = {
    compareAndSet: vi.fn(
      async (key: string, expected: string | undefined, receipt: GitHubPrEffectReceipt) => {
        if (rows.get(key)?.digest !== expected) {
          return false;
        }
        if (expected === undefined) {
          onClaim?.();
        }
        rows.set(key, receipt);
        return true;
      },
    ),
    read: vi.fn(async (key: string) => rows.get(key)),
  };
  const provider = {
    inspect: vi.fn(async () => initial),
    markReady: vi.fn(async () => ready),
    merge: vi.fn(async () => merged),
  };
  const execute = async (
    intent: GitHubPrEffectIntent,
    approvedByCallId = "original-approval",
    abortSignal?: AbortSignal,
  ) =>
    await executeApprovedGitHubPrEffect({
      ...(abortSignal === undefined ? {} : { abortSignal }),
      approvedByCallId,
      intent,
      provider,
      store,
    });
  const reconcile = async (intent: GitHubPrEffectIntent) =>
    await reconcileApprovedGitHubPrEffect({
      approvedByCallId: "recovery-call",
      intent,
      provider,
      store,
    });
  return { execute, provider, reconcile, rows, store };
};

it("does not reserve a new effect or query GitHub when the journal has no matching row", async () => {
  const { reconcile, provider, store } = fixture(passed);
  await expect(reconcile(mergeIntent)).resolves.toBeUndefined();
  expect(store.compareAndSet).not.toHaveBeenCalled();
  expect(provider.inspect).not.toHaveBeenCalled();
  expect(provider.merge).not.toHaveBeenCalled();
});

it("uses the original ready journal to confirm a lost response without a second ready request", async () => {
  const { execute, provider, reconcile } = fixture(draft);
  provider.markReady.mockRejectedValueOnce(new Error("Transport lost the response"));
  await expect(execute(readyIntent)).resolves.toMatchObject({ status: "pending" });
  provider.inspect.mockResolvedValueOnce(ready);
  await expect(reconcile(readyIntent)).resolves.toMatchObject({
    approvedByCallId: "original-approval",
    evidence: { kind: "pr-ready", readyAt },
    status: "succeeded",
  });
  expect(provider.markReady).toHaveBeenCalledTimes(1);
});

it("claims a single pending intent before concurrent ready calls can write", async () => {
  const { execute, provider, rows } = fixture(draft);
  provider.markReady.mockImplementation(async () => {
    expect([...rows.values()]).toMatchObject([{ status: "pending" }]);
    return ready;
  });
  await Promise.all([execute(readyIntent), execute(readyIntent, "concurrent-approval")]);
  expect(provider.markReady).toHaveBeenCalledTimes(1);
  expect([...rows.values()]).toMatchObject([
    { evidence: { kind: "pr-ready", readyAt }, status: "succeeded" },
  ]);
});

it("reconciles a lost merge response by readback and preserves the original approval", async () => {
  const { execute, provider, reconcile } = fixture(passed);
  const { signal } = new AbortController();
  provider.merge.mockRejectedValueOnce(new Error("Transport lost the response"));
  await expect(execute(mergeIntent, "original-approval", signal)).resolves.toMatchObject({
    status: "pending",
  });
  provider.inspect.mockResolvedValueOnce({ ...merged, readyAt: newerReadyAt });
  await expect(reconcile(mergeIntent)).resolves.toMatchObject({ status: "pending" });
  provider.inspect.mockResolvedValueOnce(merged);
  await expect(reconcile(mergeIntent)).resolves.toMatchObject({
    approvedByCallId: "original-approval",
    evidence: { kind: "pr-merge", mergeCommitSha: merged.mergeCommitSha },
    status: "succeeded",
  });
  expect(provider.merge).toHaveBeenCalledExactlyOnceWith(mergeIntent, readyAt, signal);
});

it("aborts without reserving an effect when cancellation arrives during inspection", async () => {
  const { execute, provider, store } = fixture(passed);
  const controller = new AbortController();
  provider.inspect.mockImplementationOnce(async () => {
    controller.abort();
    return passed;
  });
  await expect(execute(mergeIntent, "original-approval", controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(store.compareAndSet).not.toHaveBeenCalled();
  expect(provider.merge).not.toHaveBeenCalled();
});

it("records cancellation after a successful claim without dispatching GitHub", async () => {
  const controller = new AbortController();
  const { execute, provider, reconcile } = fixture(passed, () => {
    controller.abort();
  });
  await expect(execute(mergeIntent, "original-approval", controller.signal)).resolves.toMatchObject(
    {
      approvedByCallId: "original-approval",
      code: "cancelled",
      status: "failed",
    },
  );
  await expect(reconcile(mergeIntent)).resolves.toMatchObject({ status: "failed" });
  expect(provider.inspect).toHaveBeenCalledTimes(1);
  expect(provider.merge).not.toHaveBeenCalled();
});

it("records a definitive provider rejection without treating it as an uncertain outcome", async () => {
  const { execute, provider, reconcile } = fixture(passed);
  provider.merge.mockRejectedValueOnce(new GitHubPrEffectRejectedError("provider-rejected"));
  await expect(execute(mergeIntent)).resolves.toMatchObject({
    code: "provider-rejected",
    status: "failed",
  });
  await expect(reconcile(mergeIntent)).resolves.toMatchObject({ status: "failed" });
  expect(provider.inspect).toHaveBeenCalledTimes(1);
  expect(provider.merge).toHaveBeenCalledTimes(1);
});

it.each([
  { ...passed, headSha: "e".repeat(40) },
  { ...passed, baseBranch: "different-base" },
  { ...passed, readyAt: newerReadyAt },
  ready,
])("rejects stale or unqualified merge state before reserving an effect", async (observation) => {
  const { execute, provider, store } = fixture(observation);
  await expect(execute(mergeIntent)).rejects.toThrow("no longer");
  expect(provider.merge).not.toHaveBeenCalled();
  expect(store.compareAndSet).not.toHaveBeenCalled();
});
