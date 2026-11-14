/* oxlint-disable anti-slop/no-module-mocking -- Exercise the public tool while controlling only its external read boundaries. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import observeProductionTool from "../../agent/tools/observe-app-production";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Keep the real error class while replacing the protected client.
import type * as productionClientModule from "./repository-production-client";

const mocks = vi.hoisted(() => ({
  publicationRuntime: vi.fn(),
  productionClient: vi.fn(),
  reviewedDelivery: vi.fn(),
  savedSchemaBinding: vi.fn(),
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: mocks.publicationRuntime,
}));
vi.mock("./github-pr-delivery-subject", () => ({
  resolveGitHubPrDeliverySubject: mocks.reviewedDelivery,
}));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: vi.fn() } }));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: vi.fn() },
}));
vi.mock("./direct-production-state", () => ({
  savedDirectProductionSchemaBinding: mocks.savedSchemaBinding,
}));
vi.mock("./repository-production-client", async (original) => ({
  ...(await original<typeof productionClientModule>()),
  repositoryProductionClientForContext: mocks.productionClient,
}));

const appId = "socket-label-log";
const sample = {
  appId,
  status: "available",
  requestedRevision: "unassessed",
  deployment: { state: "active" },
  app: { state: "sign-in-required", url: "https://example.com/socket-label-log" },
};

// oxlint-disable-next-line typescript/promise-function-async -- Keep the tool's promise available to drive with the test clock.
const observe = (abortSignal: AbortSignal = new AbortController().signal) =>
  observeProductionTool.execute(
    { appId },
    // SAFETY: Only these context fields are read by the tool. Its external clients are test ports.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Provide the actual fields used by this tool.
    { abortSignal, session: { id: "session", auth: {} } } as never,
  );

beforeEach(() => {
  vi.useFakeTimers();
  mocks.publicationRuntime.mockReset();
  mocks.productionClient.mockReset();
  mocks.reviewedDelivery.mockReset();
  mocks.savedSchemaBinding.mockReset();
});
afterEach(() => vi.useRealTimers());

it("returns the observed availability without waiting for the deadline", async () => {
  mocks.productionClient.mockResolvedValue({ nativeStatus: vi.fn().mockResolvedValue(sample) });
  await expect(observe()).resolves.toEqual(sample);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { binding: { kind: "unverified" }, settled: false, expected: "awaiting-activation" },
  {
    binding: { kind: "verified", grantDigest: "b".repeat(64) },
    settled: false,
    expected: "awaiting-activation",
  },
  { binding: { kind: "verified", grantDigest: "b".repeat(64) }, settled: true, expected: "live" },
])(
  "reports the saved schema revision as $expected with settlement $settled",
  async ({ binding, settled, expected }) => {
    const repositoryId = "1";
    const mergeSha = "a".repeat(40);
    mocks.reviewedDelivery.mockReturnValue({ appId, proposalDigest: "proposal" });
    mocks.savedSchemaBinding.mockReturnValue(binding);
    mocks.publicationRuntime.mockResolvedValue({
      inspectPublishedPullRequest: vi.fn().mockResolvedValue({
        state: "merged",
        reviewedRevision: true,
        mergeCommitSha: mergeSha,
        reviewedTarget: { repositoryId, owner: "test-owner", name: "test-repo" },
      }),
    });
    const liveStatus = {
      ...sample,
      destination: { repositoryId, repositoryFullName: "test-owner/test-repo" },
      requestedRevision: "live",
    };
    const nativeStatus = vi
      .fn()
      .mockResolvedValue(settled ? { ...liveStatus, schemaSetupSettled: true } : liveStatus);
    mocks.productionClient.mockResolvedValue({ nativeStatus });
    await expect(observe()).resolves.toMatchObject({
      status: "available",
      requestedRevision: expected,
    });
    if (binding.kind === "verified") {
      expect(nativeStatus).toHaveBeenCalledWith(appId, mergeSha, undefined, binding.grantDigest);
    }
  },
);

it("bounds a stalled GitHub read and ignores late evidence", async () => {
  const pullRequest = Promise.withResolvers<unknown>();
  mocks.reviewedDelivery.mockReturnValue({ appId, proposalDigest: "proposal" });
  mocks.publicationRuntime.mockResolvedValue({
    inspectPublishedPullRequest: vi.fn().mockReturnValue(pullRequest.promise),
  });
  const reading = observe();
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(reading).resolves.toMatchObject({
    appId,
    status: "service-unavailable",
    requestedRevision: "unassessed",
    serviceIssue: "provider-read",
  });
  pullRequest.resolve({ state: "merged", reviewedRevision: true, mergeCommitSha: "merge" });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.productionClient).not.toHaveBeenCalled();
});

it("aborts the protected status read when the deadline passes", async () => {
  const pending = Promise.withResolvers<unknown>();
  const parent = new AbortController();
  mocks.productionClient.mockResolvedValue({
    nativeStatus: vi.fn().mockReturnValue(pending.promise),
  });
  const reading = observe(parent.signal);
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(reading).resolves.toMatchObject({ status: "service-unavailable" });
  expect(mocks.productionClient.mock.calls).toMatchObject([[{ abortSignal: { aborted: true } }]]);
  expect(parent.signal.aborted).toBe(false);
});

it("propagates cancellation even when the status client does not return", async () => {
  const pending = Promise.withResolvers<unknown>();
  mocks.productionClient.mockReturnValue(pending.promise);
  const owner = new AbortController();
  const reading = observe(owner.signal);
  const cancelled = expect(reading).rejects.toThrow("Stopped by the creator");
  owner.abort(new Error("Stopped by the creator"));
  await cancelled;
  expect(vi.getTimerCount()).toBe(0);
});
