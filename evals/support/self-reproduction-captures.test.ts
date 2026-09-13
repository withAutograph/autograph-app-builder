import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  captureParity,
  runPairedCaptureEvidence,
  unavailableCaptureObservations,
  writePairedCaptureManifest,
} from "./self-reproduction-captures";
import type { CaptureAdapter } from "./self-reproduction-captures";
import { requirements } from "./self-reproduction-parity";

describe("paired capture orchestration", () => {
  it("captures all desktop states separately, records inert controls, and closes contexts", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "parity-capture-test-"));
    const close = vi.fn(() => Promise.resolve());
    const newContext = vi.fn(() =>
      Promise.resolve({
        close,
        newPage: () =>
          Promise.resolve({
            screenshot: ({ path }: { path: string }) => writeFile(path, "test screenshot bytes"),
          }),
      }),
    );
    const adapter: CaptureAdapter = {
      exercise: async (_page, state, capture) => {
        await capture();
        const requirement = requirements.find((row) => row.id === `capture/desktop/${state}`);
        if (!requirement) {
          throw new Error(`Missing desktop capture requirement for ${state}`);
        }
        return requirement.assertions.map((id) => ({
          detail:
            state === "keyboard" ? "Activation did not change state." : "Test transition observed.",
          id,
          passed: state !== "keyboard",
        }));
      },
      prepare: () => Promise.resolve({ ready: true }),
    };
    try {
      const result = await captureParity({
        adapters: { candidate: adapter, reference: adapter },
        browser: { newContext } as unknown as Browser,
        outputRoot: root,
      });
      expect(result.reference).toHaveLength(15);
      expect(result.candidate).toHaveLength(15);
      expect(close).toHaveBeenCalledTimes(30);
      expect(newContext.mock.calls).toHaveLength(30);
      const receipt = JSON.parse(
        await readFile(
          nodePath.join(root, "parity/captures/desktop/keyboard/candidate.json"),
          "utf-8",
        ),
      );
      expect(receipt.assertions.every((item: { passed: boolean }) => !item.passed)).toBe(true);
      const [referenceCapture] = result.reference;
      const [candidateCapture] = result.candidate;
      if (!referenceCapture || !candidateCapture) {
        throw new Error("Expected reference and candidate captures");
      }
      expect(referenceCapture.artifacts).not.toEqual(candidateCapture.artifacts);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  it("leaves every missing adapter case unassessed without launching a browser", async () => {
    const newContext = vi.fn();
    const result = await captureParity({
      adapters: {},
      browser: { newContext } as unknown as Browser,
      outputRoot: "/unused",
    });
    expect(
      [...result.reference, ...result.candidate].every((row) => row.disposition === "not-run"),
    ).toBe(true);
    expect(newContext).not.toHaveBeenCalled();
  });
  it("retains blocked rows when browser infrastructure is unavailable", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "parity-capture-unavailable-"));
    const adapter: CaptureAdapter = {
      exercise: vi.fn(),
      prepare: vi.fn(),
    };
    try {
      const browser = {
        newContext: () => Promise.reject(new Error("Browser disconnected")),
      } as unknown as Browser;
      const result = await captureParity({
        adapters: { candidate: adapter },
        browser,
        outputRoot: root,
      });
      expect(result.candidate).toHaveLength(15);
      expect(
        result.candidate.every((row) => row.disposition === "infrastructure-unavailable"),
      ).toBe(true);
      expect(adapter.prepare).not.toHaveBeenCalled();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  it("owns one browser and writes a side-by-side advisory manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "parity-capture-manifest-"));
    const closeBrowser = vi.fn(() => Promise.resolve());
    const closeContext = vi.fn(() => Promise.resolve());
    const newContext = vi.fn(() =>
      Promise.resolve({
        newPage: () =>
          Promise.resolve({
            screenshot: ({ path }: { path: string }) => writeFile(path, "png"),
          }),
        close: closeContext,
      }),
    );
    const adapter: CaptureAdapter = {
      prepare: () => Promise.resolve({ ready: true }),
      exercise: async (_page, state, capture) => {
        await capture();
        return requirements
          .find((row) => row.id === `capture/desktop/${state}`)!
          .assertions.map((id) => ({ id, passed: true, detail: "Observed." }));
      },
    };
    try {
      const result = await runPairedCaptureEvidence({
        outputRoot: root,
        adapters: { reference: adapter, candidate: adapter },
        launch: () => Promise.resolve({ newContext, close: closeBrowser } as unknown as Browser),
      });
      expect(closeBrowser).toHaveBeenCalledOnce();
      expect(closeContext).toHaveBeenCalledTimes(30);
      expect(result.manifest.rows).toHaveLength(15);
      expect(result.manifest.visualScoresAdvisory).toBe(true);
      expect(result.manifest.rows[0]).toMatchObject({
        reference: { disposition: "observed" },
        candidate: { disposition: "observed" },
      });
      const manifest = JSON.parse(
        await readFile(join(root, "parity/captures/manifest.json"), "utf-8"),
      );
      expect(manifest.rows).toHaveLength(15);
      expect(manifest.rows[0].reference.png).toContain("/reference.png");
      expect(manifest.rows[0].candidate.png).toContain("/candidate.png");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reports browser launch failure as blocked paired evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "parity-capture-blocked-manifest-"));
    try {
      const observations = unavailableCaptureObservations("Chromium could not launch.");
      const manifest = await writePairedCaptureManifest(root, observations);
      expect(manifest.rows).toHaveLength(15);
      expect(
        [...observations.reference, ...observations.candidate].every(
          (row) => row.disposition === "infrastructure-unavailable",
        ),
      ).toBe(true);
      expect(manifest.rows[0]).toMatchObject({
        reference: { disposition: "infrastructure-unavailable" },
        candidate: { disposition: "infrastructure-unavailable" },
      });
      expect(manifest.rows[0]!.reference).not.toHaveProperty("png");
      expect(manifest.rows[0]!.reference).not.toHaveProperty("receipt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
