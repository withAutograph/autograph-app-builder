import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { createCaptureAdapters } from "./default-capture-adapter";

const absentLocator = {
  count: () => Promise.resolve(0),
};

describe("default self-reproduction capture adapter", () => {
  it("creates independent reference and candidate adapters", async () => {
    const adapters = await createCaptureAdapters({
      referenceURL: "http://127.0.0.1:3000",
      candidateURL: "http://127.0.0.1:3001",
    });
    expect(adapters.reference).not.toBe(adapters.candidate);
  });

  it("classifies absent semantic candidate behavior as missing functionality", async () => {
    const { candidate } = await createCaptureAdapters({
      referenceURL: "http://127.0.0.1:3000",
      candidateURL: "http://127.0.0.1:3001",
    });
    const page = {
      goto: vi.fn(() => Promise.resolve()),
      getByRole: vi.fn(() => absentLocator),
      getByText: vi.fn(() => absentLocator),
      locator: vi.fn(() => absentLocator),
    } as unknown as Page;
    await expect(candidate.prepare(page, "error")).resolves.toMatchObject({
      ready: false,
      disposition: "missing-functionality",
    });
  });

  it("reserves blockers for an unavailable browser target", async () => {
    const { candidate } = await createCaptureAdapters({
      referenceURL: "http://127.0.0.1:3000",
      candidateURL: "http://127.0.0.1:3001",
    });
    const page = {
      goto: vi.fn(() => Promise.reject(new Error("connection refused"))),
    } as unknown as Page;
    await expect(candidate.prepare(page, "empty")).resolves.toMatchObject({
      ready: false,
      disposition: "infrastructure-unavailable",
    });
  });
});
