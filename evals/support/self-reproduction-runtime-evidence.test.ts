import { describe, expect, it } from "vitest";
import type { Observation } from "./self-reproduction-parity";
import { mergeRuntimeEvidence } from "./self-reproduction-runtime-evidence";

const observation = (
  disposition: Observation["disposition"],
  reason: string = disposition,
): Observation => ({
    artifacts: ["candidate-runtime.json"],
    assertions: [],
    disposition,
    method: "browser",
    reason,
    requirementId: "documentation",
});
const receipt = (value: Observation, side = "candidate") => ({
    observation: value,
    producer: "evaluator",
    schemaVersion: "self-reproduction-runtime-receipt/v1",
    side,
});

describe("runtime evidence precedence", () => {
  it("replaces adapter not-run with actual documentation probe exactly once", () => {
    const probe = observation("observed");
    expect(
      mergeRuntimeEvidence({
        candidateFallback: [probe, probe],
        trustedReceipts: [receipt(observation("not-run"))],
      }),
    ).toEqual([receipt(probe)]);
  });
  it("preserves trusted observed behavior over runtime fallback and deduplicates receipts", () => {
    const trusted = receipt(observation("observed", "trusted browser assertions"));
    expect(
      mergeRuntimeEvidence({
        candidateFallback: [observation("missing-functionality")],
        trustedReceipts: [trusted, receipt(observation("not-run")), trusted],
      }),
    ).toEqual([trusted]);
  });
  it("keeps reference and candidate evidence independent", () => {
    const reference = receipt(observation("not-run"), "reference");
    const failure = observation("infrastructure-unavailable");
    expect(
      mergeRuntimeEvidence({
        candidateFallback: [failure],
        trustedReceipts: [reference, receipt(observation("not-run"))],
      }),
    ).toEqual([reference, receipt(failure)]);
  });
  it("does not erase an explicit trusted failure or hide malformed evidence", () => {
    const failed = receipt(observation("missing-functionality"));
    const invalid = { observation: { requirementId: "documentation" }, side: "candidate" };
    expect(
      mergeRuntimeEvidence({
        candidateFallback: [observation("observed")],
        trustedReceipts: [invalid, failed],
      }),
    ).toEqual([invalid, failed]);
  });
});
