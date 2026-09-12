/* oxlint-disable eslint/no-await-in-loop -- paired browser states must execute sequentially to preserve isolation and deterministic evidence. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
        disposition: "missing-functionality" | "infrastructure-unavailable";
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

/** Uses an already available browser; never starts a server or provider job. */
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
          await context?.close().catch(() => undefined);
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
