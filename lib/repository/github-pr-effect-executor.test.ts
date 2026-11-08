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
  kind: "pr-ready",
  publicationDigest: "a".repeat(64),
  installationIdentityDigest: "b".repeat(64),
  repositoryId: "100",
  owner: "withAutograph",
  name: "app",
  pullRequestNumber: 12,
  headSha: "c".repeat(40),
  baseBranch: "main",
} satisfies GitHubPrEffectIntent;
const mergeIntent = { ...readyIntent, kind: "pr-merge", readyAt } satisfies GitHubPrEffectIntent;
const draft: GitHubPrDeliveryObservation = {
  state: "open",
  draft: true,
  headSha: readyIntent.headSha,
  baseBranch: readyIntent.baseBranch,
  checks: "pending",
};
const ready: GitHubPrDeliveryObservation = { ...draft, draft: false, readyAt };
const passed: GitHubPrDeliveryObservation = { ...ready, checks: "passed", checkRunId: 42 };
const merged: GitHubPrDeliveryObservation = {
  ...passed,
  state: "merged",
  mergeCommitSha: "d".repeat(40),
};

const fixture = (initial: GitHubPrDeliveryObservation, onClaim?: () => void) => {
  const rows = new Map<string, GitHubPrEffectReceipt>();
  const store = {
    read: vi.fn((key: string) => Promise.resolve(rows.get(key))),
    compareAndSet: vi.fn(
      (key: string, expected: string | undefined, receipt: GitHubPrEffectReceipt) => {
        if (rows.get(key)?.digest !== expected) {
          return Promise.resolve(false);
        }
        if (expected === undefined) {
          onClaim?.();
        }
        rows.set(key, receipt);
        return Promise.resolve(true);
      },
    ),
  };
  const provider = {
    inspect: vi.fn<() => Promise<GitHubPrDeliveryObservation>>().mockResolvedValue(initial),
    markReady: vi.fn<() => Promise<GitHubPrDeliveryObservation>>().mockResolvedValue(ready),
    merge: vi.fn<() => Promise<GitHubPrDeliveryObservation>>().mockResolvedValue(merged),
  };
  const execute = (
    intent: GitHubPrEffectIntent,
    approvedByCallId = "original-approval",
    abortSignal?: AbortSignal,
  ) => {
    const signal: Pick<Parameters<typeof executeApprovedGitHubPrEffect>[0], "abortSignal"> = {};
    if (abortSignal !== undefined) {
      signal.abortSignal = abortSignal;
    }
    return executeApprovedGitHubPrEffect({
      ...signal,
      intent,
      approvedByCallId,
      store,
      provider,
    });
  };
  const reconcile = (intent: GitHubPrEffectIntent) =>
    reconcileApprovedGitHubPrEffect({ intent, approvedByCallId: "recovery-call", store, provider });
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
  provider.markReady.mockImplementation(() => {
    expect([...rows.values()]).toMatchObject([{ status: "pending" }]);
    return Promise.resolve(ready);
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
  provider.inspect.mockImplementationOnce(() => {
    controller.abort();
    return Promise.resolve(passed);
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
