/* oxlint-disable eslint/no-await-in-loop -- paired browser states must execute sequentially to preserve isolation and deterministic evidence. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function unavailableCaptureObservations(reason: string): PairedCaptureRun["observations"] {
  return Object.fromEntries(
    sides.map((side) => [
      side,
      desktopViewports.flatMap((viewport) =>
        captureStates.map((state): Observation => ({
          requirementId: `capture/${viewport.name}/${state}`,
          disposition: "infrastructure-unavailable",
          reason,
          method: "none",
          artifacts: [],
          assertions: [],
        })),
      ),
    ]),
  ) as PairedCaptureRun["observations"];
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function writePairedCaptureManifest(
  outputRoot: string,
  observations: PairedCaptureRun["observations"],
): Promise<PairedCaptureRun["manifest"]> {
  const rows = desktopViewports.flatMap((viewport) =>
    captureStates.map((state): PairedCaptureManifestRow => {
      const requirementId = `capture/${viewport.name}/${state}`;
      const pair = Object.fromEntries(
        sides.map((side) => {
          const observation = observations[side].find(
            (item) => item.requirementId === requirementId,
          );
          const prefix = `parity/captures/${viewport.name}/${state}/${side}`;
          return [
            side,
            {
              disposition: observation?.disposition ?? "not-run",
              ...(observation?.artifacts.includes(`${prefix}.png`) ? { png: `${prefix}.png` } : {}),
              ...(observation?.artifacts.includes(`${prefix}.json`)
                ? { receipt: `${prefix}.json` }
                : {}),
            },
          ];
        }),
      ) as Pick<PairedCaptureManifestRow, "reference" | "candidate">;
      return { requirementId, viewport, state, ...pair };
    }),
  );
  const manifest: PairedCaptureRun["manifest"] = {
    schemaVersion: "self-reproduction-captures/v1",
    visualScoresAdvisory: true,
    rows,
  };
  const manifestPath = join(outputRoot, "parity/captures/manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
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
  const output: Record<(typeof sides)[number], Observation[]> = { reference: [], candidate: [] };
  for (const viewport of desktopViewports)
    for (const state of captureStates)
      for (const side of sides) {
        const requirementId = `capture/${viewport.name}/${state}`;
        const adapter = input.adapters[side];
        if (!adapter) {
          output[side].push({
            requirementId,
            disposition: "not-run",
            reason: "No evaluator adapter supplied.",
            method: "none",
            artifacts: [],
            assertions: [],
          });
          continue;
        }
        // New cookies/storage for every case and side. Durable fixtures live in
        // each app's own store; adapters authenticate via that app's test harness.
        let context: BrowserContext | undefined;
        let interactionStarted = false;
        const prefix = `parity/captures/${viewport.name}/${state}/${side}`;
        const png = `${prefix}.png`;
        const receipt = `${prefix}.json`;
        let captured = false;
        let result: Observation;
        try {
          context = await input.browser.newContext({ viewport });
          const page = await context.newPage();
          interactionStarted = true;
          const prepared = await adapter.prepare(page, state);
          if (prepared.ready) {
            const assertions = await adapter.exercise(page, state, async () => {
              await mkdir(dirname(join(input.outputRoot, png)), { recursive: true });
              await page.screenshot({ path: join(input.outputRoot, png), fullPage: true });
              captured = true;
            });
            result = {
              requirementId,
              disposition: "observed",
              method: "browser",
              reason: captured
                ? "Paired fixture executed in an isolated browser context."
                : "Adapter omitted the state capture.",
              artifacts: captured ? [png, receipt] : [receipt],
              assertions: assertions.map((assertion) => ({ ...assertion, artifacts: [receipt] })),
            };
          } else {
            result = {
              requirementId,
              disposition: prepared.disposition,
              reason: prepared.reason,
              method: "none",
              artifacts: [],
              assertions: [],
            };
          }
        } catch {
          // Unexpected UI/selector failures are failures, not infrastructure claims.
          // Avoid serializing arbitrary errors containing callback tokens or cookies.
          result = {
            requirementId,
            disposition: interactionStarted ? "observed" : "infrastructure-unavailable",
            reason: interactionStarted
              ? "Fixture interaction threw; inspect sanitized evaluator diagnostics."
              : "The browser could not create an isolated fixture page.",
            method: interactionStarted ? "browser" : "none",
            artifacts: [receipt],
            assertions: interactionStarted
              ? [
                  {
                    id: "fixture-execution",
                    passed: false,
                    detail: "The fixture did not complete.",
                    artifacts: [receipt],
                  },
                ]
              : [],
          };
        } finally {
          // Preserve the case receipt if the browser disconnected during cleanup.
          await context?.close().catch(() => {
            // Cleanup errors are intentionally ignored.
          });
        }
        await mkdir(dirname(join(input.outputRoot, receipt)), { recursive: true });
        await writeFile(
          join(input.outputRoot, receipt),
          `${JSON.stringify({ side, viewport, state, ...result }, null, 2)}\n`,
          { mode: 0o600 },
        );
        output[side].push(result);
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
  const browser = await (input.launch ?? (() => chromium.launch({ headless: true })))();
  let observations: Record<(typeof sides)[number], Observation[]>;
  try {
    observations = await captureParity({
      browser,
      outputRoot: input.outputRoot,
      adapters: input.adapters,
    });
  } finally {
    await browser.close();
  }
  const manifest = await writePairedCaptureManifest(input.outputRoot, observations);
  return { observations, manifest };
}
