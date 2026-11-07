/* oxlint-disable eslint/no-await-in-loop -- workflow cases run sequentially to preserve deterministic durable state. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

import { runtimeReceiptSchema } from "./self-reproduction-parity-evidence";
import { sides, workflowMatrix } from "./self-reproduction-parity";
import type { Observation } from "./self-reproduction-parity";

export type WorkflowId = (typeof workflowMatrix)[number]["id"];
type RuntimeReceipt = ReturnType<typeof runtimeReceiptSchema.parse>;
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

const recordReceipt = async (
  input: { outputRoot: string },
  side: (typeof sides)[number],
  receiptPath: string,
  observation: Observation,
): Promise<RuntimeReceipt> => {
  const receipt = runtimeReceiptSchema.parse({
    observation,
    producer: "evaluator",
    schemaVersion: "self-reproduction-runtime-receipt/v1",
    side,
  });
  const destination = path.join(input.outputRoot, receiptPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
};

const observeWorkflow = async (
  input: {
    browser: Browser;
    adapters: Partial<Record<(typeof sides)[number], TrustedBrowserWorkflowAdapter>>;
  },
  side: (typeof sides)[number],
  workflow: (typeof testedWorkflows)[number],
  receiptPath: string,
): Promise<Observation> => {
  const adapter = input.adapters[side];
  if (!adapter) {
    return {
      artifacts: [],
      assertions: [],
      disposition: "not-run",
      method: "none",
      reason: "No trusted evaluator adapter was supplied for this side.",
      requirementId: workflow.id,
    };
  }

  const contexts: BrowserContext[] = [];
  try {
    const context = await input.browser.newContext(adapter.contextOptions);
    contexts.push(context);
    const page = await context.newPage();
    const prepared = await adapter.prepare(page, workflow.id);
    if (!prepared.ready) {
      return {
        artifacts: [],
        assertions: [],
        disposition: prepared.disposition,
        method: "none",
        reason: prepared.reason,
        requirementId: workflow.id,
      };
    }
    const exercised = await adapter.exercise(page, workflow.id, async () => {
      const fresh = await input.browser.newContext(adapter.contextOptions);
      contexts.push(fresh);
      return await fresh.newPage();
    });
    const verified = await adapter.verify(workflow.id);
    const artifacts = [receiptPath, ...(exercised.artifacts ?? []), ...(verified.artifacts ?? [])];
    return {
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
  } catch {
    return failedObservation(
      workflow.id,
      "Trusted fixture interaction or server readback failed; inspect evaluator diagnostics.",
      receiptPath,
    );
  } finally {
    for (const context of contexts) {
      try {
        await context.close();
      } catch {
        // Cleanup does not change the recorded product outcome.
      }
    }
  }
};

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
  const receipts: RuntimeReceipt[] = [];
  for (const side of sides) {
    for (const workflow of testedWorkflows) {
      const receiptPath = `parity/workflows/${workflow.id}/${side}.json`;
      const observation = await observeWorkflow(input, side, workflow, receiptPath);
      const receipt = await recordReceipt(input, side, receiptPath, observation);
      observations[side].push(observation);
      receipts.push(receipt);
    }
  }
  return { observations, receipts };
};
