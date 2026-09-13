import { describe, expect, it } from "vitest";
import type { Observation } from "./self-reproduction-parity";
import { mergeRuntimeEvidence } from "./self-reproduction-runtime-evidence";

function observation(
  disposition: Observation["disposition"],
  reason: string = disposition,
): Observation {
  return {
    requirementId: "documentation",
    disposition,
    reason,
    assertions: [],
    artifacts: ["candidate-runtime.json"],
    method: "browser",
  };
}
function receipt(value: Observation, side = "candidate") {
  return {
    schemaVersion: "self-reproduction-runtime-receipt/v1",
    producer: "evaluator",
    side,
    observation: value,
  };
}

describe("runtime evidence precedence", () => {
  it("replaces adapter not-run with actual documentation probe exactly once", () => {
    const probe = observation("observed");
    expect(
      mergeRuntimeEvidence({
        trustedReceipts: [receipt(observation("not-run"))],
        candidateFallback: [probe, probe],
      }),
    ).toEqual([receipt(probe)]);
  });
  it("preserves trusted observed behavior over runtime fallback and deduplicates receipts", () => {
    const trusted = receipt(observation("observed", "trusted browser assertions"));
    expect(
      mergeRuntimeEvidence({
        trustedReceipts: [trusted, receipt(observation("not-run")), trusted],
        candidateFallback: [observation("missing-functionality")],
      }),
    ).toEqual([trusted]);
  });
  it("keeps reference and candidate evidence independent", () => {
    const reference = receipt(observation("not-run"), "reference");
    const failure = observation("infrastructure-unavailable");
    expect(
      mergeRuntimeEvidence({
        trustedReceipts: [reference, receipt(observation("not-run"))],
        candidateFallback: [failure],
      }),
    ).toEqual([reference, receipt(failure)]);
  });
  it("does not erase an explicit trusted failure or hide malformed evidence", () => {
    const failed = receipt(observation("missing-functionality"));
    const invalid = { side: "candidate", observation: { requirementId: "documentation" } };
    expect(
      mergeRuntimeEvidence({
        trustedReceipts: [invalid, failed],
        candidateFallback: [observation("observed")],
      }),
    ).toEqual([invalid, failed]);
  });
});
