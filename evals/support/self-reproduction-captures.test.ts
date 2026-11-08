import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  captureParity,
  runPairedCaptureEvidence,
  unavailableCaptureObservations,
  writePairedCaptureManifest,
} from "./self-reproduction-captures";
import type { CaptureAdapter, CapturePage } from "./self-reproduction-captures";
import { requirements } from "./self-reproduction-parity";

const launchBrowser = vi.hoisted(() => vi.fn());
vi.mock("playwright", () => ({ chromium: { launch: launchBrowser } }));

describe("paired capture orchestration", () => {
  it("launches and closes the default browser through the production wrapper", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "parity-capture-wrapper-"));
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    const newContext = vi.fn();
    launchBrowser.mockResolvedValueOnce({ close, newContext });
    try {
      const result = await runPairedCaptureEvidence({ adapters: {}, outputRoot: root });
      expect(launchBrowser).toHaveBeenCalledWith({ headless: true });
      expect(newContext).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(result.manifest.rows).toHaveLength(15);
      expect(result.observations.reference.every((item) => item.disposition === "not-run")).toBe(
        true,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  it("propagates a browser launch failure from the production wrapper", async () => {
    const failure = new Error("Browser launch unavailable");
    await expect(
      runPairedCaptureEvidence({
        adapters: {},
        launch: () => Promise.reject(failure),
        outputRoot: "/unused",
      }),
    ).rejects.toBe(failure);
  });
  it("captures all desktop states separately, records inert controls, and closes contexts", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "parity-capture-test-"));
    const close = vi.fn(async () => {});
    const newContext = vi.fn(() =>
      Promise.resolve({
        close,
        newPage: () =>
          Promise.resolve({
            screenshot: ({ path }: { path: string }) => writeFile(path, "test screenshot bytes"),
          }),
      }),
    );
    const adapter: CaptureAdapter<CapturePage> = {
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
        browser: { newContext },
        outputRoot: root,
      });
      expect(result.reference).toHaveLength(15);
      expect(result.candidate).toHaveLength(15);
      expect(close).toHaveBeenCalledTimes(30);
      expect(newContext.mock.calls).toHaveLength(30);
      const receipt = z
        .object({ assertions: z.array(z.object({ passed: z.boolean() })) })
        .parse(
          JSON.parse(
            await readFile(
              nodePath.join(root, "parity/captures/desktop/keyboard/candidate.json"),
              "utf-8",
            ),
          ),
        );
      expect(receipt.assertions.every((item) => !item.passed)).toBe(true);
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
      browser: { newContext },
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
      };
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
    const root = await mkdtemp(nodePath.join(tmpdir(), "parity-capture-manifest-"));
    const closeBrowser = vi.fn(async () => {});
    const closeContext = vi.fn(async () => {});
    const newContext = vi.fn(() =>
      Promise.resolve({
        close: closeContext,
        newPage: () =>
          Promise.resolve({
            screenshot: ({ path }: { path: string }) => writeFile(path, "png"),
          }),
      }),
    );
    const adapter: CaptureAdapter = {
      exercise: async (_page, state, capture) => {
        await capture();
        const requirement = requirements.find((row) => row.id === `capture/desktop/${state}`);
        if (!requirement) {
          throw new Error(`Unknown capture state: ${state}`);
        }
        return requirement.assertions.map((id) => ({ detail: "Observed.", id, passed: true }));
      },
      prepare: () => Promise.resolve({ ready: true }),
    };
    try {
      launchBrowser.mockClear();
      launchBrowser.mockResolvedValueOnce({ close: closeBrowser, newContext });
      const result = await runPairedCaptureEvidence({
        adapters: { candidate: adapter, reference: adapter },
        outputRoot: root,
      });
      expect(launchBrowser).toHaveBeenCalledOnce();
      expect(launchBrowser).toHaveBeenCalledWith({ headless: true });
      expect(closeBrowser).toHaveBeenCalledOnce();
      expect(closeContext).toHaveBeenCalledTimes(30);
      expect(result.manifest.rows).toHaveLength(15);
      expect(result.manifest.visualScoresAdvisory).toBe(true);
      expect(result.manifest.rows[0]).toMatchObject({
        candidate: { disposition: "observed" },
        reference: { disposition: "observed" },
      });
      const manifest = z
        .object({
          rows: z.array(
            z.object({
              candidate: z.object({ png: z.string().optional() }),
              reference: z.object({ png: z.string().optional() }),
            }),
          ),
        })
        .parse(
          JSON.parse(await readFile(nodePath.join(root, "parity/captures/manifest.json"), "utf-8")),
        );
      expect(manifest.rows).toHaveLength(15);
      expect(manifest.rows[0].reference.png).toContain("/reference.png");
      expect(manifest.rows[0].candidate.png).toContain("/candidate.png");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  it("reports browser launch failure as blocked paired evidence", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "parity-capture-blocked-manifest-"));
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
        candidate: { disposition: "infrastructure-unavailable" },
        reference: { disposition: "infrastructure-unavailable" },
      });
      const [firstRow] = manifest.rows;
      if (!firstRow) {
        throw new Error("Expected a capture manifest row.");
      }
      expect(firstRow.reference).not.toHaveProperty("png");
      expect(firstRow.reference).not.toHaveProperty("receipt");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
