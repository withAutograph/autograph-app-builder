/* oxlint-disable eslint/no-await-in-loop, eslint/no-negated-condition, unicorn/no-negated-condition -- framework rows run sequentially and readiness unions read most clearly from their negative branch. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

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
      disposition: "missing-functionality" | "infrastructure-unavailable";
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
  ) => Promise<{ reason: string; assertions: AssertionResult[]; artifacts: string[] }>;
  instantNavigationRecipe: () => Promise<
    | {
        ready: true;
        recipe: Parameters<typeof assertParityNavigation>[1];
        artifacts: string[];
      }
    | {
        ready: false;
        disposition: "missing-functionality" | "infrastructure-unavailable";
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
export async function runTrustedFrameworkEvidence(input: {
  browser: Browser;
  outputRoot: string;
  adapters: Partial<Record<(typeof sides)[number], TrustedFrameworkAdapter>>;
  runInstant?: typeof assertParityNavigation;
}): Promise<TrustedFrameworkRun> {
  const observations: TrustedFrameworkRun["observations"] = { reference: [], candidate: [] };
  const receipts: unknown[] = [];
  const runInstant = input.runInstant ?? assertParityNavigation;
  for (const side of sides)
    for (const requirement of frameworkMatrix) {
      const receiptPath = `parity/framework/${requirement.id}/${side}.json`;
      const adapter = input.adapters[side];
      let observation!: Observation;
      let context: BrowserContext | undefined;
      if (!adapter) {
        observation = {
          requirementId: requirement.id,
          disposition: "not-run",
          reason: "No trusted framework adapter was supplied for this side.",
          method: "none",
          artifacts: [],
          assertions: [],
        };
      } else {
        try {
          const source = await adapter.reviewSource(requirement.id);
          if (!source.ready) {
            observation = {
              requirementId: requirement.id,
              disposition: source.disposition,
              reason: source.reason,
              method: "source-review",
              artifacts: source.artifacts,
              assertions: [],
            };
          } else {
            context = await input.browser.newContext();
            const page = await context.newPage();
            let browserResult:
              | {
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
                  requirementId: requirement.id,
                  disposition: navigation.disposition,
                  reason: navigation.reason,
                  method: "none",
                  artifacts: source.artifacts,
                  assertions: source.assertions,
                };
              } else {
                await runInstant(page, navigation.recipe);
                method = "@next/playwright/instant";
                browserResult = {
                  reason:
                    "Direct and client navigations exposed useful instant UI and resolved content.",
                  artifacts: navigation.artifacts,
                  assertions: requirement.assertions.map((id) => ({
                    id,
                    passed: true,
                    detail: "Observed with the installed @next/playwright instant helper.",
                    artifacts: navigation.artifacts,
                  })),
                };
              }
            } else browserResult = await adapter.exerciseBrowser(page, requirement.id);
            if (browserResult) {
              const artifacts = [receiptPath, ...source.artifacts, ...browserResult.artifacts];
              observation = {
                requirementId: requirement.id,
                disposition: "observed",
                reason: `${source.reason} ${browserResult.reason}`,
                method,
                artifacts: [...new Set(artifacts)],
                assertions: [...source.assertions, ...browserResult.assertions].map(
                  (assertion) => ({
                    ...assertion,
                    artifacts: [...new Set([receiptPath, ...assertion.artifacts])],
                  }),
                ),
              };
            }
          }
        } catch {
          observation = {
            requirementId: requirement.id,
            disposition: "observed",
            reason:
              "Trusted source review or browser execution failed; inspect evaluator diagnostics.",
            method: "source-and-browser",
            artifacts: [receiptPath],
            assertions: [
              {
                id: "fixture-execution",
                passed: false,
                detail: "The framework evaluation did not complete.",
                artifacts: [receiptPath],
              },
            ],
          };
        } finally {
          await context?.close().catch(() => {
            // Cleanup does not change the framework outcome.
          });
        }
      }
      const receipt = runtimeReceiptSchema.parse({
        schemaVersion: "self-reproduction-runtime-receipt/v1",
        producer: "evaluator",
        side,
        observation,
      });
      await mkdir(dirname(join(input.outputRoot, receiptPath)), { recursive: true });
      await writeFile(
        join(input.outputRoot, receiptPath),
        `${JSON.stringify(receipt, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      observations[side].push(observation);
      receipts.push(receipt);
    }
  return { observations, receipts };
}
