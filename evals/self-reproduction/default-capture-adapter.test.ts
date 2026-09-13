import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { createCaptureAdapters } from "./default-capture-adapter";

const absentLocator = {
  count: () => Promise.resolve(0),
};

describe("default self-reproduction capture adapter", () => {
  it("creates independent reference and candidate adapters", async () => {
    const adapters = await createCaptureAdapters({
      candidateURL: "http://127.0.0.1:3001",
      referenceURL: "http://127.0.0.1:3000",
    });
    expect(adapters.reference).not.toBe(adapters.candidate);
  });

  it("classifies an absent required candidate control as missing functionality", async () => {
    const { candidate } = await createCaptureAdapters({
      candidateURL: "http://127.0.0.1:3001",
      referenceURL: "http://127.0.0.1:3000",
    });
    const page = {
      getByRole: vi.fn(() => absentLocator),
      getByText: vi.fn(() => absentLocator),
      goto: vi.fn(() => Promise.resolve()),
      locator: vi.fn(() => absentLocator),
    } as unknown as Page;
    await expect(candidate.prepare(page, "panel-resize")).resolves.toMatchObject({
      disposition: "missing-functionality",
      ready: false,
    });
  });

  it("does not mistake an unseeded transient state for missing product functionality", async () => {
    const { reference, candidate } = await createCaptureAdapters({
      candidateURL: "http://127.0.0.1:3001",
      referenceURL: "http://127.0.0.1:3000",
    });
    const page = {
      getByRole: vi.fn(() => absentLocator),
      getByText: vi.fn(() => absentLocator),
      goto: vi.fn(() => Promise.resolve()),
      locator: vi.fn(() => absentLocator),
    } as unknown as Page;
    await expect(reference.prepare(page, "loading")).resolves.toMatchObject({
      disposition: "not-run",
      ready: false,
    });
    await expect(candidate.prepare(page, "error")).resolves.toMatchObject({
      disposition: "not-run",
      ready: false,
    });
  });

  it("reserves blockers for an unavailable browser target", async () => {
    const { candidate } = await createCaptureAdapters({
      candidateURL: "http://127.0.0.1:3001",
      referenceURL: "http://127.0.0.1:3000",
    });
    const page = {
      goto: vi.fn(() => Promise.reject(new Error("connection refused"))),
    } as unknown as Page;
    await expect(candidate.prepare(page, "empty")).resolves.toMatchObject({
      disposition: "infrastructure-unavailable",
      ready: false,
    });
  });
});
