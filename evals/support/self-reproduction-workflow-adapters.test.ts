import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { assessParity, requirements } from "./self-reproduction-parity";
import { parityEvidenceFromReceipts } from "./self-reproduction-parity-evidence";
import { runTrustedBrowserWorkflows } from "./self-reproduction-workflow-adapters";
import type {
  TrustedBrowserWorkflowAdapter,
  WorkflowId,
} from "./self-reproduction-workflow-adapters";

const assertionIds = (id: WorkflowId) => {
  const requirement = requirements.find((item) => item.id === id);
  if (!requirement) {throw new Error(`Unknown workflow: ${id}`);}
  return requirement.assertions;
};

const adapter = (input?: {
  missing?: WorkflowId;
  unavailable?: WorkflowId;
  fail?: WorkflowId;
}): TrustedBrowserWorkflowAdapter => ({
  exercise: async (_page, id, freshPage) => {
    if (id === "authentication" || id === "durable-draft" || id === "session-recovery")
      {await freshPage();}
    return {
      assertions: assertionIds(id)
        .filter((_, index) => index % 2 === 0)
        .map((assertion) => ({
          detail: id === input?.fail ? "Transition did not occur." : "Transition observed.",
          id: assertion,
          passed: id !== input?.fail,
        })),
      reason: "Browser transition observed.",
    };
  },
  prepare: (_page, id) => {
    if (id === input?.missing)
      {return Promise.resolve({
        disposition: "missing-functionality" as const,
        ready: false as const,
        reason: "Control absent.",
      });}
    if (id === input?.unavailable)
      {return Promise.resolve({
        disposition: "infrastructure-unavailable" as const,
        ready: false as const,
        reason: "Fixture database unavailable.",
      });}
    return Promise.resolve({ ready: true as const });
  },
  verify: (id) =>
    Promise.resolve({
      assertions: assertionIds(id)
        .filter((_, index) => index % 2 === 1)
        .map((assertion) => ({
          detail: "Durable readback matched.",
          id: assertion,
          passed: true,
        })),
      reason: "Server readback completed.",
    }),
});

const browser = () => {
  const close = vi.fn(() => Promise.resolve());
  const newPage = vi.fn(() => Promise.resolve({}));
  const newContext = vi.fn(() => Promise.resolve({ close, newPage }));
  return { close, newContext, newPage, value: { newContext } as unknown as Browser };
};

describe("trusted browser workflow adapters", () => {
  it("runs every non-anonymous workflow per side and requires browser plus server assertions", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "trusted-workflows-"));
    const fixtureBrowser = browser();
    try {
      const run = await runTrustedBrowserWorkflows({
        adapters: { candidate: adapter(), reference: adapter() },
        browser: fixtureBrowser.value,
        outputRoot,
      });
      expect(run.observations.reference).toHaveLength(11);
      expect(run.observations.candidate).toHaveLength(11);
      expect(
        run.observations.candidate.some((item) => item.requirementId === "anonymous-entry"),
      ).toBe(false);
      const evidence = parityEvidenceFromReceipts({
        candidate: { output: "available", reason: "ready", sourceRevision: "candidate" },
        reference: { output: "available", reason: "ready", sourceRevision: "ref" },
        runId: "trusted",
        runtimeReceipts: run.receipts,
      });
      const assessed = await assessParity(evidence, () => Promise.resolve(true));
      expect(
        assessed.rows
          .filter(
            (row) =>
              row.side === "candidate" &&
              run.observations.candidate.some(
                (observation) => observation.requirementId === row.requirementId,
              ),
          )
          .every((row) => row.status === "passed"),
      ).toBe(true);
      expect(fixtureBrowser.newContext.mock.calls.length).toBeGreaterThan(22);
      const receipt = JSON.parse(
        await readFile(
          path.join(outputRoot, "parity/workflows/durable-draft/candidate.json"),
          "utf-8",
        ),
      );
      expect(receipt.producer).toBe("evaluator");
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("maps missing functionality, unavailable fixtures and failed behavior distinctly", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "trusted-workflows-status-"));
    try {
      const run = await runTrustedBrowserWorkflows({
        adapters: {
          candidate: adapter({
            fail: "retry",
            missing: "provider-return-success",
            unavailable: "app-creation",
          }),
        },
        browser: browser().value,
        outputRoot,
      });
      const evidence = parityEvidenceFromReceipts({
        candidate: { output: "available", reason: "ready", sourceRevision: "candidate" },
        reference: { output: "available", reason: "ready", sourceRevision: "ref" },
        runId: "status",
        runtimeReceipts: run.receipts,
      });
      const { rows } = await assessParity(evidence, () => Promise.resolve(true));
      const candidate = (id: string) =>
        rows.find((row) => row.side === "candidate" && row.requirementId === id);
      expect(candidate("provider-return-success")).toMatchObject({
        reasonCode: "missing-functionality",
        status: "failed",
      });
      expect(candidate("app-creation")).toMatchObject({
        reasonCode: "observation-infrastructure-unavailable",
        status: "blocked",
      });
      expect(candidate("retry")).toMatchObject({
        reasonCode: "assertion-failed",
        status: "failed",
      });
      expect(
        rows.find((row) => row.side === "reference" && row.requirementId === "durable-draft"),
      ).toMatchObject({ reasonCode: "observation-not-run", status: "unassessed" });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("records fixture exceptions as functional failures and closes all contexts", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "trusted-workflows-error-"));
    const fixtureBrowser = browser();
    const broken = adapter();
    broken.verify = () => Promise.reject(new Error("secret database error"));
    try {
      const run = await runTrustedBrowserWorkflows({
        adapters: { candidate: broken },
        browser: fixtureBrowser.value,
        outputRoot,
      });
      expect(run.observations.candidate.every((item) => item.disposition === "observed")).toBe(
        true,
      );
      expect(
        run.observations.candidate.every((item) =>
          item.assertions.some((assertion) => !assertion.passed),
        ),
      ).toBe(true);
      expect(JSON.stringify(run)).not.toContain("secret database error");
      expect(fixtureBrowser.close).toHaveBeenCalled();
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});
