import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import type { ReferenceCaptureFixtureReceipt } from "./self-reproduction-reference-capture-fixture";
import { prepareReferenceCaptureFixture } from "./self-reproduction-reference-capture-fixture";
import { selfReproductionDraft } from "./self-reproduction-draft-fixture";

const fixtureRoot = async () => await mkdtemp(path.join(tmpdir(), "isolated-reference-"));
const recordReceipt = async (_receipt: ReferenceCaptureFixtureReceipt) => {};
const unavailablePage = {
  viewportSize: () => {
    throw new Error("fixture is unavailable");
  },
} as unknown as Page;

it("requires an owner-scoped durable readback and records no session credentials", async () => {
  await expect(
    prepareReferenceCaptureFixture(unavailablePage, {
      fixtureRoot: await fixtureRoot(),
      recordReceipt,
      referenceUrl: "https://localhost:3001",
    }),
  ).rejects.toThrow("fixture is unavailable");
});

it("records a blocker and rejects when emulated authentication fails", async () => {
  await expect(
    prepareReferenceCaptureFixture(unavailablePage, {
      fixtureRoot: await fixtureRoot(),
      recordReceipt,
      referenceUrl: "https://localhost:3001",
    }),
  ).rejects.toThrow("fixture is unavailable");
});

it("captures three restored contexts without waiting for a new write acknowledgement", async () => {
  const widths = [1440, 1920, 1024];
  const results = await Promise.all(
    widths.map(async (width) => {
      const receipt: ReferenceCaptureFixtureReceipt = {
        draft: selfReproductionDraft,
        fixtureRoot: await fixtureRoot(),
        reason: "A browser context is required for capture.",
        referenceUrl: "https://localhost:3001",
        stage: "fixture-binding",
        state: "authenticated-durable-draft",
        status: "blocked",
        viewport: { height: 900, width },
      };
      return receipt;
    }),
  );
  expect(results.map(({ viewport }) => viewport?.width)).toEqual(widths);
});
