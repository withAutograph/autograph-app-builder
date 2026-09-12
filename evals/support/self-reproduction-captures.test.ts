import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { captureParity } from "./self-reproduction-captures";
import type { CaptureAdapter } from "./self-reproduction-captures";
import { requirements } from "./self-reproduction-parity";

describe("paired capture orchestration", () => {
  it("captures all desktop states separately, records inert controls, and closes contexts", async () => {
    const root = await mkdtemp(join(tmpdir(), "parity-capture-test-"));
    const close = vi.fn(async () => {});
    const newContext = vi.fn(async () => ({
      newPage: async () => ({
        screenshot: async ({ path }: { path: string }) => writeFile(path, "test screenshot bytes"),
      }),
      close,
    }));
    const adapter: CaptureAdapter = {
      prepare: async () => ({ ready: true }),
      exercise: async (_page, state, capture) => {
        await capture();
        return requirements
          .find((row) => row.id === `capture/desktop/${state}`)!
          .assertions.map((id) => ({
            id,
            passed: state !== "keyboard",
            detail:
              state === "keyboard"
                ? "Activation did not change state."
                : "Test transition observed.",
          }));
      },
    };
    try {
      const result = await captureParity({
        browser: { newContext } as unknown as Browser,
        outputRoot: root,
        adapters: { reference: adapter, candidate: adapter },
      });
      expect(result.reference).toHaveLength(15);
      expect(result.candidate).toHaveLength(15);
      expect(close).toHaveBeenCalledTimes(30);
      expect(newContext.mock.calls).toHaveLength(30);
      const receipt = JSON.parse(
        await readFile(join(root, "parity/captures/desktop/keyboard/candidate.json"), "utf-8"),
      );
      expect(receipt.assertions.every((item: { passed: boolean }) => !item.passed)).toBe(true);
      expect(result.reference[0]!.artifacts).not.toEqual(result.candidate[0]!.artifacts);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("leaves every missing adapter case unassessed without launching a browser", async () => {
    const newContext = vi.fn();
    const result = await captureParity({
      browser: { newContext } as unknown as Browser,
      outputRoot: "/unused",
      adapters: {},
    });
    expect(
      [...result.reference, ...result.candidate].every((row) => row.disposition === "not-run"),
    ).toBe(true);
    expect(newContext).not.toHaveBeenCalled();
  });
  it("retains blocked rows when browser infrastructure is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "parity-capture-unavailable-"));
    const adapter: CaptureAdapter = {
      prepare: vi.fn(),
      exercise: vi.fn(),
    };
    try {
      const browser = {
        newContext: async () => {
          throw new Error("Browser disconnected");
        },
      } as unknown as Browser;
      const result = await captureParity({
        browser,
        outputRoot: root,
        adapters: { candidate: adapter },
      });
      expect(result.candidate).toHaveLength(15);
      expect(
        result.candidate.every((row) => row.disposition === "infrastructure-unavailable"),
      ).toBe(true);
      expect(adapter.prepare).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
