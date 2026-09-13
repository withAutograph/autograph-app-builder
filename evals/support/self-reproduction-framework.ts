/* oxlint-disable eslint/no-await-in-loop, eslint/no-negated-condition, unicorn/no-negated-condition -- framework rows run sequentially and readiness unions read most clearly from their negative branch. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { sanitizeEvidence } from "./self-reproduction-evidence";
import { runtimeReceiptSchema } from "./self-reproduction-parity-evidence";
import { assertParityNavigation } from "./self-reproduction-navigation";
import { frameworkMatrix, sides } from "./self-reproduction-parity";
import type { Observation } from "./self-reproduction-parity";

export type FrameworkId = (typeof frameworkMatrix)[number]["id"];
interface AssertionResult {
  id: string;
  passed: boolean;
  detail: string;
  artifacts: string[];
}
type ReviewResult =
  | {
      ready: true;
      reason: string;
      assertions: AssertionResult[];
      artifacts: string[];
    }
  | {
      ready: false;
      disposition: "missing-functionality" | "infrastructure-unavailable" | "not-run";
      reason: string;
      artifacts: string[];
    };

export interface TrustedFrameworkAdapter {
  /** Review the actual side source against the installed Next 16.3.4 docs. */
  reviewSource: (requirementId: FrameworkId) => Promise<ReviewResult>;
  /** Exercise the already-running side. Configuration-only findings do not belong here. */
  exerciseBrowser: (
    page: Page,
    requirementId: Exclude<FrameworkId, "instant-navigation">,
  ) => Promise<{
    disposition?: "not-run" | "infrastructure-unavailable";
    reason: string;
    assertions: AssertionResult[];
    artifacts: string[];
  }>;
  instantNavigationRecipe: () => Promise<
    | {
        ready: true;
        recipe: Parameters<typeof assertParityNavigation>[1];
        artifacts: string[];
      }
    | {
        ready: false;
        disposition: "missing-functionality" | "infrastructure-unavailable" | "not-run";
        reason: string;
      }
  >;
}

export interface TrustedFrameworkRun {
  observations: Record<(typeof sides)[number], Observation[]>;
  receipts: unknown[];
}

/**
 * Joins source review and real browser behavior. Source-only evidence never
 * emits an observed row, and instant navigation always uses @next/playwright.
 */
export const runTrustedFrameworkEvidence = async (input: {
  browser: Browser;
  outputRoot: string;
  adapters: Partial<Record<(typeof sides)[number], TrustedFrameworkAdapter>>;
  runInstant?: typeof assertParityNavigation;
}): Promise<TrustedFrameworkRun> => {
  const observations: TrustedFrameworkRun["observations"] = { candidate: [], reference: [] };
  const receipts: unknown[] = [];
  const runInstant = input.runInstant ?? assertParityNavigation;
  for (const side of sides)
    for (const requirement of frameworkMatrix) {
      const receiptPath = `parity/framework/${requirement.id}/${side}.json`;
      const adapter = input.adapters[side];
      let observation!: Observation;
      let context: BrowserContext | undefined;
      let instantAssertionRunning = false;
      if (!adapter) {
        observation = {
          artifacts: [],
          assertions: [],
          disposition: "not-run",
          method: "none",
          reason: "No trusted framework adapter was supplied for this side.",
          requirementId: requirement.id,
        };
      } else {
        try {
          const source = await adapter.reviewSource(requirement.id);
          if (!source.ready) {
            observation = {
              artifacts: source.artifacts,
              assertions: [],
              disposition: source.disposition,
              method: "source-review",
              reason: source.reason,
              requirementId: requirement.id,
            };
          } else {
            context = await input.browser.newContext();
            const page = await context.newPage();
            let browserResult:
              | {
                  disposition?: "not-run" | "infrastructure-unavailable";
                  reason: string;
                  assertions: AssertionResult[];
                  artifacts: string[];
                }
              | undefined;
            let method: Observation["method"] = "source-and-browser";
            if (requirement.id === "instant-navigation") {
              const navigation = await adapter.instantNavigationRecipe();
              if (!navigation.ready) {
                observation = {
                  artifacts: source.artifacts,
                  assertions: source.assertions,
                  disposition: navigation.disposition,
                  method: "none",
                  reason: navigation.reason,
                  requirementId: requirement.id,
                };
              } else {
                instantAssertionRunning = true;
                await runInstant(page, navigation.recipe);
                instantAssertionRunning = false;
                method = "@next/playwright/instant";
                browserResult = {
                  artifacts: navigation.artifacts,
                  assertions: requirement.assertions.map((id) => ({
                    artifacts: navigation.artifacts,
                    detail: "Observed with the installed @next/playwright instant helper.",
                    id,
                    passed: true,
                  })),
                  reason:
                    "Direct and client navigations exposed useful instant UI and resolved content.",
                };
              }
            } else browserResult = await adapter.exerciseBrowser(page, requirement.id);
            if (browserResult) {
              const artifacts = [receiptPath, ...source.artifacts, ...browserResult.artifacts];
              observation = {
                artifacts: [...new Set(artifacts)],
                assertions: [...source.assertions, ...browserResult.assertions].map(
                  (assertion) => ({
                    ...assertion,
                    artifacts: [...new Set([receiptPath, ...assertion.artifacts])],
                  }),
                ),
                disposition: browserResult.disposition ?? "observed",
                method,
                reason: `${source.reason} ${browserResult.reason}`,
                requirementId: requirement.id,
              };
            }
          }
        } catch (error) {
          const diagnosticPath = `parity/framework/${requirement.id}/${side}-error.json`;
          await mkdir(path.dirname(path.join(input.outputRoot, diagnosticPath)), {
            recursive: true,
          });
          await writeFile(
            path.join(input.outputRoot, diagnosticPath),
            JSON.stringify(
              sanitizeEvidence({
                message: error instanceof Error ? error.message : String(error),
                name: error instanceof Error ? error.name : "Error",
                stack: error instanceof Error ? error.stack : undefined,
              }),
              null,
              2,
            ),
            { mode: 0o600 },
          );
          observation = {
            artifacts: [receiptPath, diagnosticPath],
            assertions: [
              {
                artifacts: [receiptPath],
                detail: "The framework evaluation did not complete.",
                id: "fixture-execution",
                passed: false,
              },
            ],
            disposition: instantAssertionRunning ? "observed" : "infrastructure-unavailable",
            method: "source-and-browser",
            reason: instantAssertionRunning
              ? "Instant-navigation assertion failed; inspect sanitized evaluator diagnostics."
              : "Trusted source review or browser execution threw; inspect sanitized evaluator diagnostics.",
            requirementId: requirement.id,
          };
        } finally {
          await context?.close().catch(() => {
            // Cleanup does not change the framework outcome.
          });
        }
      }
      const receipt = runtimeReceiptSchema.parse({
        observation,
        producer: "evaluator",
        schemaVersion: "self-reproduction-runtime-receipt/v1",
        side,
      });
      await mkdir(path.dirname(path.join(input.outputRoot, receiptPath)), { recursive: true });
      await writeFile(
        path.join(input.outputRoot, receiptPath),
        `${JSON.stringify(receipt, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      observations[side].push(observation);
      receipts.push(receipt);
    }
  return { observations, receipts };
};
