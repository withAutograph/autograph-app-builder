import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { assessParity, requirements } from "./self-reproduction-parity";
import { parityEvidenceFromReceipts } from "./self-reproduction-parity-evidence";
import { runTrustedBrowserWorkflows } from "./self-reproduction-workflow-adapters";
import type {
  TrustedBrowserWorkflowAdapter,
  WorkflowId,
} from "./self-reproduction-workflow-adapters";

function assertionIds(id: WorkflowId) {
  return requirements.find((item) => item.id === id)!.assertions;
}

function adapter(input?: {
  missing?: WorkflowId;
  unavailable?: WorkflowId;
  fail?: WorkflowId;
}): TrustedBrowserWorkflowAdapter {
  return {
    prepare: (_page, id) =>
      Promise.resolve(
        id === input?.missing
          ? { ready: false, disposition: "missing-functionality", reason: "Control absent." }
          : id === input?.unavailable
            ? {
                ready: false,
                disposition: "infrastructure-unavailable",
                reason: "Fixture database unavailable.",
              }
            : { ready: true },
      ),
    exercise: async (_page, id, freshPage) => {
      if (id === "authentication" || id === "durable-draft" || id === "session-recovery")
        await freshPage();
      return {
        reason: "Browser transition observed.",
        assertions: assertionIds(id)
          .filter((_, index) => index % 2 === 0)
          .map((assertion) => ({
            id: assertion,
            passed: id !== input?.fail,
            detail: id === input?.fail ? "Transition did not occur." : "Transition observed.",
          })),
      };
    },
    verify: (id) =>
      Promise.resolve({
        reason: "Server readback completed.",
        assertions: assertionIds(id)
          .filter((_, index) => index % 2 === 1)
          .map((assertion) => ({
            id: assertion,
            passed: true,
            detail: "Durable readback matched.",
          })),
      }),
  };
}

function browser() {
  const close = vi.fn(() => Promise.resolve());
  const newPage = vi.fn(() => Promise.resolve({}));
  const newContext = vi.fn(() => Promise.resolve({ newPage, close }));
  return { value: { newContext } as unknown as Browser, newContext, newPage, close };
}

describe("trusted browser workflow adapters", () => {
  it("runs every non-anonymous workflow per side and requires browser plus server assertions", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "trusted-workflows-"));
    const fixtureBrowser = browser();
    try {
      const run = await runTrustedBrowserWorkflows({
        browser: fixtureBrowser.value,
        outputRoot,
        adapters: { reference: adapter(), candidate: adapter() },
      });
      expect(run.observations.reference).toHaveLength(11);
      expect(run.observations.candidate).toHaveLength(11);
      expect(
        run.observations.candidate.some((item) => item.requirementId === "anonymous-entry"),
      ).toBe(false);
      const evidence = parityEvidenceFromReceipts({
        runId: "trusted",
        reference: { output: "available", reason: "ready", sourceRevision: "ref" },
        candidate: { output: "available", reason: "ready", sourceRevision: "candidate" },
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
        await readFile(join(outputRoot, "parity/workflows/durable-draft/candidate.json"), "utf-8"),
      );
      expect(receipt.producer).toBe("evaluator");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("maps missing functionality, unavailable fixtures and failed behavior distinctly", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "trusted-workflows-status-"));
    try {
      const run = await runTrustedBrowserWorkflows({
        browser: browser().value,
        outputRoot,
        adapters: {
          candidate: adapter({
            missing: "provider-return-success",
            unavailable: "app-creation",
            fail: "retry",
          }),
        },
      });
      const evidence = parityEvidenceFromReceipts({
        runId: "status",
        reference: { output: "available", reason: "ready", sourceRevision: "ref" },
        candidate: { output: "available", reason: "ready", sourceRevision: "candidate" },
        runtimeReceipts: run.receipts,
      });
      const { rows } = await assessParity(evidence, () => Promise.resolve(true));
      const candidate = (id: string) =>
        rows.find((row) => row.side === "candidate" && row.requirementId === id);
      expect(candidate("provider-return-success")).toMatchObject({
        status: "failed",
        reasonCode: "missing-functionality",
      });
      expect(candidate("app-creation")).toMatchObject({
        status: "blocked",
        reasonCode: "observation-infrastructure-unavailable",
      });
      expect(candidate("retry")).toMatchObject({
        status: "failed",
        reasonCode: "assertion-failed",
      });
      expect(
        rows.find((row) => row.side === "reference" && row.requirementId === "durable-draft"),
      ).toMatchObject({ status: "unassessed", reasonCode: "observation-not-run" });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("records fixture exceptions as functional failures and closes all contexts", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "trusted-workflows-error-"));
    const fixtureBrowser = browser();
    const broken = adapter();
    broken.verify = () => Promise.reject(new Error("secret database error"));
    try {
      const run = await runTrustedBrowserWorkflows({
        browser: fixtureBrowser.value,
        outputRoot,
        adapters: { candidate: broken },
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
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
