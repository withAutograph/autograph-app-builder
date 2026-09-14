/* oxlint-disable eslint/no-await-in-loop -- workflow cases run sequentially to preserve deterministic durable state. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

import { runtimeReceiptSchema } from "./self-reproduction-parity-evidence";
import { sides, workflowMatrix } from "./self-reproduction-parity";
import type { Observation } from "./self-reproduction-parity";

export type WorkflowId = (typeof workflowMatrix)[number]["id"];
export interface AssertionResult {
  id: string;
  passed: boolean;
  detail: string;
  artifacts?: string[];
}
export type Preparation =
  | { ready: true }
  | {
      ready: false;
      disposition: "not-run" | "missing-functionality" | "infrastructure-unavailable";
      reason: string;
    };

export interface TrustedBrowserWorkflowAdapter {
  contextOptions?: BrowserContextOptions;
  /** Seeds only records owned by this eval run in the side's real persistence layer. */
  prepare: (page: Page, workflowId: WorkflowId) => Promise<Preparation>;
  /** Drives the rendered application. It may request isolated contexts for auth/readback checks. */
  exercise: (
    page: Page,
    workflowId: WorkflowId,
    freshPage: () => Promise<Page>,
  ) => Promise<{
    reason: string;
    assertions: AssertionResult[];
    artifacts?: string[];
  }>;
  /** Performs evaluator-owned server readback after browser interaction. */
  verify: (workflowId: WorkflowId) => Promise<{
    reason: string;
    assertions: AssertionResult[];
    artifacts?: string[];
  }>;
}

export interface TrustedWorkflowRun {
  observations: Record<(typeof sides)[number], Observation[]>;
  receipts: unknown[];
}

const testedWorkflows = workflowMatrix.filter((item) => item.id !== "anonymous-entry");

const failedObservation = (
  requirementId: WorkflowId,
  reason: string,
  receipt: string,
): Observation => ({
  artifacts: [receipt],
  assertions: [
    {
      artifacts: [receipt],
      detail: "The trusted browser workflow did not complete.",
      id: "fixture-execution",
      passed: false,
    },
  ],
  disposition: "observed",
  method: "browser",
  reason,
  requirementId,
});

/**
 * Uses already-running applications and an already-available browser. The
 * adapters are evaluator code: generated applications can expose normal
 * fixture endpoints, but cannot author observations or assertion outcomes.
 */
export const runTrustedBrowserWorkflows = async (input: {
  browser: Browser;
  outputRoot: string;
  adapters: Partial<Record<(typeof sides)[number], TrustedBrowserWorkflowAdapter>>;
}): Promise<TrustedWorkflowRun> => {
  const observations: TrustedWorkflowRun["observations"] = { candidate: [], reference: [] };
  const receipts: unknown[] = [];
  for (const side of sides) {
    for (const workflow of testedWorkflows) {
      const receiptPath = `parity/workflows/${workflow.id}/${side}.json`;
      const adapter = input.adapters[side];
      let observation: Observation;
      const contexts: BrowserContext[] = [];
      // oxlint-disable-next-line eslint/no-negated-condition, unicorn/no-negated-condition -- absent adapter is the explicit unassessed branch
      if (!adapter) {
        observation = {
          artifacts: [],
          assertions: [],
          disposition: "not-run",
          method: "none",
          reason: "No trusted evaluator adapter was supplied for this side.",
          requirementId: workflow.id,
        };
      } else {
        try {
          const context = await input.browser.newContext(adapter.contextOptions);
          contexts.push(context);
          const page = await context.newPage();
          const prepared = await adapter.prepare(page, workflow.id);
          // oxlint-disable-next-line eslint/no-negated-condition, unicorn/no-negated-condition -- rejected preparation carries the required failure classification
          if (!prepared.ready) {
            observation = {
              artifacts: [],
              assertions: [],
              disposition: prepared.disposition,
              method: "none",
              reason: prepared.reason,
              requirementId: workflow.id,
            };
          } else {
            const exercised = await adapter.exercise(page, workflow.id, async () => {
              const fresh = await input.browser.newContext(adapter.contextOptions);
              contexts.push(fresh);
              return await fresh.newPage();
            });
            const verified = await adapter.verify(workflow.id);
            const artifacts = [
              receiptPath,
              ...(exercised.artifacts ?? []),
              ...(verified.artifacts ?? []),
            ];
            observation = {
              artifacts: [...new Set(artifacts)],
              assertions: [...exercised.assertions, ...verified.assertions].map((assertion) => ({
                ...assertion,
                artifacts: [...new Set([receiptPath, ...(assertion.artifacts ?? [])])],
              })),
              disposition: "observed",
              method: "browser",
              reason: `${exercised.reason} ${verified.reason}`,
              requirementId: workflow.id,
            };
          }
        } catch {
          observation = failedObservation(
            workflow.id,
            "Trusted fixture interaction or server readback failed; inspect evaluator diagnostics.",
            receiptPath,
          );
        } finally {
          for (const context of contexts) {
            await context.close().catch(() => {
              // Cleanup does not change the recorded product outcome.
            });
          }
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
  }
  return { observations, receipts };
};
