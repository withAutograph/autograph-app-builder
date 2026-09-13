import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import type { ReferenceCaptureFixtureReceipt } from "./self-reproduction-reference-capture-fixture";
import { prepareReferenceCaptureFixture } from "./self-reproduction-reference-capture-fixture";
import { selfReproductionDraft } from "./self-reproduction-draft-fixture";

const fixture = vi.hoisted(() => ({
  authenticate: vi.fn(() => Promise.resolve()),
  query: vi.fn(),
  end: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../e2e/support/harness", () => ({
  appOrigin: "https://localhost:3001",
  currentSession: () => Promise.resolve({ user: { id: "synthetic-owner" } }),
  databaseUrl: "postgresql://synthetic",
  finishOAuth: fixture.authenticate,
  waitForBuilderReady: () => Promise.resolve(),
}));
vi.mock("postgres", () => ({ default: () => Object.assign(fixture.query, { end: fixture.end }) }));
const page = {
  getByLabel: () => ({ fill: vi.fn() }),
  getByRole: () => ({ filter: () => ({ waitFor: vi.fn() }) }),
  viewportSize: () => ({ height: 900, width: 1440 }),
} as unknown as Page;

it("requires an owner-scoped durable readback and records no session credentials", async () => {
  fixture.query.mockResolvedValue([{ ...selfReproductionDraft, revision: 7 }]);
  const recordReceipt = vi.fn<(receipt: ReferenceCaptureFixtureReceipt) => Promise<void>>(() =>
    Promise.resolve(),
  );
  await prepareReferenceCaptureFixture(page, {
    fixtureRoot: "/tmp/isolated-reference",
    recordReceipt,
    referenceUrl: "https://localhost:3001",
  });
  const receipt = recordReceipt.mock.calls[0]?.[0];
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
  const recordReceipt = vi.fn<(receipt: ReferenceCaptureFixtureReceipt) => Promise<void>>(() =>
    Promise.resolve(),
  );
  await expect(
    prepareReferenceCaptureFixture(page, {
      fixtureRoot: "/tmp/isolated-reference",
      recordReceipt,
      referenceUrl: "https://localhost:3001",
    }),
  ).rejects.toThrow("fixture is unavailable");
  expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked" }));
  expect(JSON.stringify(recordReceipt.mock.calls)).not.toContain("sensitive diagnostic");
});
