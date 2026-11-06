/* oxlint-disable eslint/no-await-in-loop -- paired browser states must execute sequentially to preserve isolation and deterministic evidence. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { captureStates, desktopViewports, sides } from "./self-reproduction-parity";
import type { Observation } from "./self-reproduction-parity";

export type CaptureState = (typeof captureStates)[number];
export interface CaptureAdapter {
  // Seed only isolated test-owned records. Missing generated controls must be
  // returned as missing-functionality, never hidden by fixture HTML or mocks.
  prepare: (
    page: Page,
    state: CaptureState,
  ) => Promise<
    | { ready: true }
    | {
        ready: false;
        disposition: "missing-functionality" | "infrastructure-unavailable" | "not-run";
        reason: string;
      }
  >;
  // Exercise the real UI. The contract specifies each assertion's semantics.
  // Retain the transient state using capture() before releasing its latch or
  // clicking recovery. Only assertion observations belong in the return value.
  exercise: (
    page: Page,
    state: CaptureState,
    capture: () => Promise<void>,
  ) => Promise<
    {
      id: string;
      passed: boolean;
      detail: string;
    }[]
  >;
}

export interface PairedCaptureManifestRow {
  requirementId: string;
  state: CaptureState;
  viewport: (typeof desktopViewports)[number];
  reference: { disposition: Observation["disposition"]; png?: string; receipt?: string };
  candidate: { disposition: Observation["disposition"]; png?: string; receipt?: string };
}

export interface PairedCaptureRun {
  observations: Record<(typeof sides)[number], Observation[]>;
  manifest: {
    schemaVersion: "self-reproduction-captures/v1";
    visualScoresAdvisory: true;
    rows: PairedCaptureManifestRow[];
  };
}

const captureManifestSide = (
  observations: Observation[],
  requirementId: string,
  viewport: (typeof desktopViewports)[number],
  state: CaptureState,
  side: (typeof sides)[number],
): PairedCaptureManifestRow["candidate"] => {
  const observation = observations.find((item) => item.requirementId === requirementId);
  const prefix = `parity/captures/${viewport.name}/${state}/${side}`;
  const result: PairedCaptureManifestRow["candidate"] = {
    disposition: observation?.disposition ?? "not-run",
  };
  if (observation?.artifacts.includes(`${prefix}.png`) === true) {
    result.png = `${prefix}.png`;
  }
  if (observation?.artifacts.includes(`${prefix}.json`) === true) {
    result.receipt = `${prefix}.json`;
  }
  return result;
};

const failedCaptureObservation = (
  interactionStarted: boolean,
  requirementId: string,
  receipt: string,
): Observation => {
  const result: Observation = {
    artifacts: [receipt],
    assertions: [],
    disposition: interactionStarted ? "observed" : "infrastructure-unavailable",
    method: interactionStarted ? "browser" : "none",
    reason: interactionStarted
      ? "Fixture interaction threw; inspect sanitized evaluator diagnostics."
      : "The browser could not create an isolated fixture page.",
    requirementId,
  };
  if (interactionStarted) {
    result.assertions.push({
      artifacts: [receipt],
      detail: "The fixture did not complete.",
      id: "fixture-execution",
      passed: false,
    });
  }
  return result;
};

const captureReceipt = async (
  input: { outputRoot: string },
  receipt: string,
  side: (typeof sides)[number],
  state: CaptureState,
  viewport: (typeof desktopViewports)[number],
  result: Observation,
): Promise<void> => {
  await mkdir(path.dirname(path.join(input.outputRoot, receipt)), { recursive: true });
  await writeFile(
    path.join(input.outputRoot, receipt),
    `${JSON.stringify({ side, state, viewport, ...result }, null, 2)}\n`,
    { mode: 0o600 },
  );
};

const capturePreparedPage = async (
  input: { outputRoot: string },
  adapter: CaptureAdapter,
  page: Page,
  state: CaptureState,
  png: string,
  receipt: string,
  requirementId: string,
): Promise<Observation> => {
  let captured = false;
  const assertions = await adapter.exercise(page, state, async () => {
    await mkdir(path.dirname(path.join(input.outputRoot, png)), { recursive: true });
    await page.screenshot({ fullPage: true, path: path.join(input.outputRoot, png) });
    captured = true;
  });
  return {
    artifacts: captured ? [png, receipt] : [receipt],
    assertions: assertions.map((assertion) => ({ ...assertion, artifacts: [receipt] })),
    disposition: "observed",
    method: "browser",
    reason: captured
      ? "Paired fixture executed in an isolated browser context."
      : "Adapter omitted the state capture.",
    requirementId,
  };
};

const captureCase = async (
  input: { browser: Browser; outputRoot: string },
  adapter: CaptureAdapter,
  viewport: (typeof desktopViewports)[number],
  state: CaptureState,
  side: (typeof sides)[number],
  requirementId: string,
): Promise<Observation> => {
  const prefix = `parity/captures/${viewport.name}/${state}/${side}`;
  const png = `${prefix}.png`;
  const receipt = `${prefix}.json`;
  let context: BrowserContext | undefined;
  let interactionStarted = false;
  let result: Observation;
  try {
    context = await input.browser.newContext({ viewport });
    const page = await context.newPage();
    interactionStarted = true;
    const prepared = await adapter.prepare(page, state);
    result = prepared.ready
      ? await capturePreparedPage(input, adapter, page, state, png, receipt, requirementId)
      : {
          artifacts: [],
          assertions: [],
          disposition: prepared.disposition,
          method: "none",
          reason: prepared.reason,
          requirementId,
        };
  } catch {
    result = failedCaptureObservation(interactionStarted, requirementId, receipt);
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // Cleanup errors are intentionally ignored.
      }
    }
  }
  await captureReceipt(input, receipt, side, state, viewport, result);
  return result;
};

export const unavailableCaptureObservations = (
  reason: string,
): PairedCaptureRun["observations"] => {
  const observations: PairedCaptureRun["observations"] = { candidate: [], reference: [] };
  for (const side of sides) {
    observations[side] = desktopViewports.flatMap((viewport) =>
      captureStates.map((state): Observation => ({
        artifacts: [],
        assertions: [],
        disposition: "infrastructure-unavailable",
        method: "none",
        reason,
        requirementId: `capture/${viewport.name}/${state}`,
      })),
    );
  }
  return observations;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function writePairedCaptureManifest(
  outputRoot: string,
  observations: PairedCaptureRun["observations"],
): Promise<PairedCaptureRun["manifest"]> {
  const rows = desktopViewports.flatMap((viewport) =>
    captureStates.map((state): PairedCaptureManifestRow => {
      const requirementId = `capture/${viewport.name}/${state}`;
      const candidate = captureManifestSide(
        observations.candidate,
        requirementId,
        viewport,
        state,
        "candidate",
      );
      const reference = captureManifestSide(
        observations.reference,
        requirementId,
        viewport,
        state,
        "reference",
      );
      return { candidate, reference, requirementId, state, viewport };
    }),
  );
  const manifest: PairedCaptureRun["manifest"] = {
    rows,
    schemaVersion: "self-reproduction-captures/v1",
    visualScoresAdvisory: true,
  };
  const manifestPath = path.join(outputRoot, "parity/captures/manifest.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** Uses an already available browser; never starts a server or provider job. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function captureParity(input: {
  browser: Browser;
  outputRoot: string;
  adapters: Partial<Record<(typeof sides)[number], CaptureAdapter>>;
}): Promise<Record<(typeof sides)[number], Observation[]>> {
  const output: Record<(typeof sides)[number], Observation[]> = { candidate: [], reference: [] };
  for (const viewport of desktopViewports) {
    for (const state of captureStates) {
      for (const side of sides) {
        const requirementId = `capture/${viewport.name}/${state}`;
        const adapter = input.adapters[side];
        if (!adapter) {
          output[side].push({
            artifacts: [],
            assertions: [],
            disposition: "not-run",
            method: "none",
            reason: "No evaluator adapter supplied.",
            requirementId,
          });
          continue;
        }
        // New cookies/storage for every case and side. Durable fixtures live in
        // each app's own store; adapters authenticate via that app's test harness.
        output[side].push(await captureCase(input, adapter, viewport, state, side, requirementId));
      }
    }
  }
  return output;
}

/**
 * Owns one headless browser for the complete paired capture matrix and writes a
 * deterministic manifest that report renderers can display side by side. The
 * manifest records evidence locations only; it never turns visual similarity
 * into functional credit.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function runPairedCaptureEvidence(input: {
  outputRoot: string;
  adapters: Partial<Record<(typeof sides)[number], CaptureAdapter>>;
  launch?: () => Promise<Browser>;
}): Promise<PairedCaptureRun> {
  const browser = await (input.launch ?? (async () => await chromium.launch({ headless: true })))();
  let observations: Record<(typeof sides)[number], Observation[]>;
  try {
    observations = await captureParity({
      adapters: input.adapters,
      browser,
      outputRoot: input.outputRoot,
    });
  } finally {
    await browser.close();
  }
  const manifest = await writePairedCaptureManifest(input.outputRoot, observations);
  return { manifest, observations };
}
