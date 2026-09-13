import { describe, expect, it } from "vitest";

import { assessParity, desktopViewports, requirements } from "./self-reproduction-parity";
import {
  captureReceiptSchema,
  parityEvidenceFromReceipts,
} from "./self-reproduction-parity-evidence";

const artifactExists = () => Promise.resolve(true);
const base = {
  candidate: { output: "available" as const, reason: "ready", sourceRevision: "candidate" },
  reference: { output: "available" as const, reason: "ready", sourceRevision: "ref" },
  runId: "receipt-fixture",
};

const runtimeReceipt = (
  requirementId: string,
  disposition: "observed" | "missing-functionality" | "infrastructure-unavailable" | "not-run",
  passed = true,
) => {
  const row = requirements.find((item) => item.id === requirementId);
  if (!row) throw new Error(`Unknown parity requirement: ${requirementId}`);
  return {
    observation: {
      artifacts: ["parity/runtime/result.json"],
      assertions: row.assertions.map((id) => ({
        artifacts: ["parity/runtime/result.json"],
        detail: passed ? "Observed." : "Expected transition did not occur.",
        id,
        passed,
      })),
      disposition,
      method: row.kind === "framework" ? "source-and-browser" : "browser",
      reason: "Evaluator fixture receipt.",
      requirementId,
    },
    producer: "evaluator",
    schemaVersion: "self-reproduction-runtime-receipt/v1",
    side: "candidate",
  };
};

describe("parity receipt ingestion", () => {
  it("maps evaluator runtime receipts to passed, failed, blocked and unassessed reason codes", async () => {
    const evidence = parityEvidenceFromReceipts({
      ...base,
      runtimeReceipts: [
        runtimeReceipt("durable-draft", "observed"),
        runtimeReceipt("provider-return-success", "observed", false),
        runtimeReceipt("app-creation", "infrastructure-unavailable"),
        runtimeReceipt("retry", "not-run"),
      ],
    });
    const assessedEvidence = await assessParity(evidence, artifactExists);
    const rows = assessedEvidence.rows.filter((row) => row.side === "candidate");
    expect(rows.find((row) => row.requirementId === "durable-draft")).toMatchObject({
      reasonCode: "observed-complete",
      status: "passed",
    });
    expect(rows.find((row) => row.requirementId === "provider-return-success")).toMatchObject({
      reasonCode: "assertion-failed",
      status: "failed",
    });
    expect(rows.find((row) => row.requirementId === "app-creation")).toMatchObject({
      reasonCode: "observation-infrastructure-unavailable",
      status: "blocked",
    });
    expect(rows.find((row) => row.requirementId === "retry")).toMatchObject({
      reasonCode: "observation-not-run",
      status: "unassessed",
    });
    expect(rows.find((row) => row.requirementId === "documentation")).toMatchObject({
      reasonCode: "observation-missing",
      status: "unassessed",
    });
  });

  it("maps missing output to failed and unavailable infrastructure to blocked", async () => {
    const missing = parityEvidenceFromReceipts({
      ...base,
      candidate: { ...base.candidate, output: "missing" },
    });
    const unavailable = parityEvidenceFromReceipts({
      ...base,
      candidate: { ...base.candidate, output: "infrastructure-unavailable" },
    });
    const missingAssessment = await assessParity(missing, artifactExists);
    const missingRow = missingAssessment.rows.find(
      (row) => row.side === "candidate" && row.requirementId === "durable-draft",
    );
    const unavailableAssessment = await assessParity(unavailable, artifactExists);
    const unavailableRow = unavailableAssessment.rows.find(
      (row) => row.side === "candidate" && row.requirementId === "durable-draft",
    );
    expect(missingRow).toMatchObject({ reasonCode: "output-missing", status: "failed" });
    expect(unavailableRow).toMatchObject({
      reasonCode: "output-infrastructure-unavailable",
      status: "blocked",
    });
  });

  it("ingests capture receipts only when viewport, state and requirement agree", async () => {
    const [viewport] = desktopViewports;
    const requirementId = `capture/${viewport.name}/keyboard`;
    const row = requirements.find((item) => item.id === requirementId);
    if (!row) throw new Error(`Unknown parity requirement: ${requirementId}`);
    const receipt = {
      artifacts: ["parity/captures/keyboard.png", "parity/captures/keyboard.json"],
      assertions: row.assertions.map((id) => ({
        artifacts: ["parity/captures/keyboard.json"],
        detail: "Observed.",
        id,
        passed: true,
      })),
      disposition: "observed",
      method: "browser",
      reason: "Keyboard path exercised.",
      requirementId,
      side: "candidate",
      state: "keyboard",
      viewport,
    };
    const evidence = parityEvidenceFromReceipts({ ...base, captureReceipts: [receipt] });
    const assessedEvidence = await assessParity(evidence, artifactExists);
    const assessed = assessedEvidence.rows.find(
      (item) => item.side === "candidate" && item.requirementId === requirementId,
    );
    expect(assessed).toMatchObject({ reasonCode: "observed-complete", status: "passed" });
    expect(
      captureReceiptSchema.safeParse({
        ...receipt,
        requirementId: "capture/desktop/error",
      }).success,
    ).toBe(false);
  });

  it("rejects candidate-authored and duplicate authoritative receipts", () => {
    expect(() =>
      parityEvidenceFromReceipts({
        ...base,
        runtimeReceipts: [
          { ...runtimeReceipt("durable-draft", "observed"), producer: "candidate" },
        ],
      }),
    ).toThrow();
    expect(() =>
      parityEvidenceFromReceipts({
        ...base,
        runtimeReceipts: [
          runtimeReceipt("durable-draft", "observed"),
          runtimeReceipt("durable-draft", "observed"),
        ],
      }),
    ).toThrow();
  });
});
