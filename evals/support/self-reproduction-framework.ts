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

interface FrameworkInput {
  browser: Browser;
  outputRoot: string;
  adapters: Partial<Record<(typeof sides)[number], TrustedFrameworkAdapter>>;
  runInstant: typeof assertParityNavigation;
}

interface FrameworkFailure {
  message: string;
  name: string;
  stack?: string;
}

const makeObservation = (
  requirementId: FrameworkId,
  disposition: Observation["disposition"],
  method: Observation["method"],
  reason: string,
  artifacts: string[],
  assertions: AssertionResult[] = [],
): Observation => ({ artifacts, assertions, disposition, method, reason, requirementId });

const recordFailure = async (
  input: FrameworkInput,
  requirementId: FrameworkId,
  side: (typeof sides)[number],
  error: FrameworkFailure,
  instantAssertionRunning: boolean,
): Promise<Observation> => {
  const diagnosticPath = `parity/framework/${requirementId}/${side}-error.json`;
  await mkdir(path.dirname(path.join(input.outputRoot, diagnosticPath)), { recursive: true });
  await writeFile(
    path.join(input.outputRoot, diagnosticPath),
    JSON.stringify(sanitizeEvidence(error), null, 2),
    { mode: 0o600 },
  );
  return makeObservation(
    requirementId,
    instantAssertionRunning ? "observed" : "infrastructure-unavailable",
    "source-and-browser",
    instantAssertionRunning
      ? "Instant-navigation assertion failed; inspect sanitized evaluator diagnostics."
      : "Trusted source review or browser execution threw; inspect sanitized evaluator diagnostics.",
    [`parity/framework/${requirementId}/${side}.json`, diagnosticPath],
    [
      {
        artifacts: [`parity/framework/${requirementId}/${side}.json`],
        detail: "The framework evaluation did not complete.",
        id: "fixture-execution",
        passed: false,
      },
    ],
  );
};

const reviewRequirement = async (
  input: FrameworkInput,
  side: (typeof sides)[number],
  requirement: (typeof frameworkMatrix)[number],
): Promise<Observation> => {
  const receiptPath = `parity/framework/${requirement.id}/${side}.json`;
  const adapter = input.adapters[side];
  if (!adapter) {
    return makeObservation(
      requirement.id,
      "not-run",
      "none",
      "No trusted framework adapter was supplied for this side.",
      [],
    );
  }

  let context: BrowserContext | undefined;
  let instantAssertionRunning = false;
  try {
    const source = await adapter.reviewSource(requirement.id);
    if (!source.ready) {
      return makeObservation(
        requirement.id,
        source.disposition,
        "source-review",
        source.reason,
        source.artifacts,
      );
    }

    context = await input.browser.newContext();
    const page = await context.newPage();
    let browserResult: Awaited<ReturnType<TrustedFrameworkAdapter["exerciseBrowser"]>>;
    let method: Observation["method"] = "source-and-browser";
    if (requirement.id === "instant-navigation") {
      const navigation = await adapter.instantNavigationRecipe();
      if (!navigation.ready) {
        return makeObservation(
          requirement.id,
          navigation.disposition,
          "none",
          navigation.reason,
          source.artifacts,
          source.assertions,
        );
      }
      instantAssertionRunning = true;
      await input.runInstant(page, navigation.recipe);
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
        reason: "Direct and client navigations exposed useful instant UI and resolved content.",
      };
    } else {
      browserResult = await adapter.exerciseBrowser(page, requirement.id);
    }

    const artifacts = [receiptPath, ...source.artifacts, ...browserResult.artifacts];
    return {
      artifacts: [...new Set(artifacts)],
      assertions: [...source.assertions, ...browserResult.assertions].map((assertion) => ({
        ...assertion,
        artifacts: [...new Set([receiptPath, ...assertion.artifacts])],
      })),
      disposition: browserResult.disposition ?? "observed",
      method,
      reason: `${source.reason} ${browserResult.reason}`,
      requirementId: requirement.id,
    };
  } catch (error) {
    const failure: FrameworkFailure = {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
    };
    if (error instanceof Error && error.stack !== undefined) {
      failure.stack = error.stack;
    }
    return await recordFailure(input, requirement.id, side, failure, instantAssertionRunning);
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // Cleanup does not change the framework outcome.
      }
    }
  }
};

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
  const frameworkInput: FrameworkInput = {
    ...input,
    runInstant: input.runInstant ?? assertParityNavigation,
  };
  for (const side of sides) {
    for (const requirement of frameworkMatrix) {
      const receiptPath = `parity/framework/${requirement.id}/${side}.json`;
      const observation = await reviewRequirement(frameworkInput, side, requirement);
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
  }
  return { observations, receipts };
};
