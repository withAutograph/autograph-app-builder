import { expect, it, vi } from "vitest";
import type { ReferenceCaptureFixtureReceipt } from "./self-reproduction-reference-capture-fixture";
import { prepareReferenceCaptureFixture } from "./self-reproduction-reference-capture-fixture";
import { selfReproductionDraft } from "./self-reproduction-draft-fixture";

const fixture = vi.hoisted(() => ({
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  authenticate: vi.fn<(page: unknown, provider: string) => Promise<void>>().mockResolvedValue(),
  end: vi.fn<() => Promise<void>>().mockResolvedValue(),
  query: vi.fn(),
}));
const harness = {
  appOrigin: "https://localhost:3001",
  currentSession: () => Promise.resolve({ user: { id: "synthetic-owner" } }),
  databaseUrl: "postgresql://synthetic",
  finishOAuth: fixture.authenticate,
  waitForBuilderReady: vi.fn<() => Promise<void>>().mockResolvedValue(),
};
const loadHarness = vi.fn<() => Promise<typeof harness>>().mockResolvedValue(harness);
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled postgres dependency used by this test.
vi.mock("postgres", () => ({ default: () => Object.assign(fixture.query, { end: fixture.end }) }));
const page = {
  getByLabel: (name: string) => ({
    fill: vi.fn(),
    inputValue: () =>
      Promise.resolve(
        name === "App Name" ? selfReproductionDraft.appName : selfReproductionDraft.brief,
      ),
  }),
  getByRole: () => ({ filter: () => ({ waitFor: vi.fn() }) }),
  viewportSize: () => ({ height: 900, width: 1440 }),
};

it("requires an owner-scoped durable readback and records no session credentials", async () => {
  loadHarness.mockClear();
  fixture.authenticate.mockClear();
  fixture.query.mockResolvedValue([{ ...selfReproductionDraft, revision: 7 }]);
  const recordReceipt = vi
    .fn<(receipt: ReferenceCaptureFixtureReceipt) => Promise<void>>()
    .mockResolvedValue();
  await prepareReferenceCaptureFixture(
    page,
    {
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture root exercises reference capture path handling.
      fixtureRoot: "/tmp/isolated-reference",
      recordReceipt,
      referenceUrl: "https://localhost:3001",
    },
    loadHarness,
  );
  const receipt = recordReceipt.mock.calls[0]?.[0];
  expect(loadHarness).toHaveBeenCalledOnce();
  expect(fixture.authenticate).toHaveBeenCalledWith(page, "GitHub");
  expect(receipt).toMatchObject({
    draftRevision: 7,
    state: "authenticated-durable-draft",
    status: "ready",
  });
  expect(JSON.stringify(receipt)).not.toContain("synthetic-owner");
  expect(fixture.query.mock.calls[0]).toContain("synthetic-owner");
  expect(fixture.end).toHaveBeenCalled();
});

it("records a blocker and rejects when emulated authentication fails", async () => {
  fixture.authenticate.mockRejectedValueOnce(new Error("sensitive diagnostic"));
  const recordReceipt = vi
    .fn<(receipt: ReferenceCaptureFixtureReceipt) => Promise<void>>()
    .mockResolvedValue();
  await expect(
    prepareReferenceCaptureFixture(
      page,
      {
        // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture root exercises reference capture path handling.
        fixtureRoot: "/tmp/isolated-reference",
        recordReceipt,
        referenceUrl: "https://localhost:3001",
      },
      loadHarness,
    ),
  ).rejects.toThrow("fixture is unavailable");
  expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked" }));
  expect(JSON.stringify(recordReceipt.mock.calls)).not.toContain("sensitive diagnostic");
});

it("captures three restored contexts without waiting for a new write acknowledgement", async () => {
  fixture.query.mockResolvedValue([{ ...selfReproductionDraft, revision: 7 }]);
  const fill = vi.fn();
  const status = vi.fn(() => {
    throw new Error("Unchanged draft has no new acknowledgement");
  });
  const recordReceipt = vi
    .fn<(receipt: ReferenceCaptureFixtureReceipt) => Promise<void>>()
    .mockResolvedValue();
  for (const width of [1440, 1920, 1024]) {
    const viewportPage = {
      ...page,
      getByLabel: (name: string) => ({
        fill,
        inputValue: () =>
          Promise.resolve(
            name === "App Name" ? selfReproductionDraft.appName : selfReproductionDraft.brief,
          ),
      }),
      getByRole: status,
      viewportSize: () => ({ height: 900, width }),
    };
    // oxlint-disable-next-line eslint/no-await-in-loop -- Match the sequential desktop capture lifecycle.
    await prepareReferenceCaptureFixture(
      viewportPage,
      {
        // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture root exercises reference capture path handling.
        fixtureRoot: "/tmp/isolated-reference",
        recordReceipt,
        referenceUrl: "https://localhost:3001",
      },
      loadHarness,
    );
  }
  expect(fill).not.toHaveBeenCalled();
  expect(status).not.toHaveBeenCalled();
  expect(recordReceipt).toHaveBeenCalledTimes(3);
  expect(
    recordReceipt.mock.calls.every(
      ([receipt]) => receipt.status === "ready" && receipt.stage === "complete",
    ),
  ).toBe(true);
});
