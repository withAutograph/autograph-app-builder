import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "../../scripts/portable-release";
import { assertExactToolDiscovery, parseReviewedProof } from "./proof-evidence";

describe("release proof evidence", () => {
  it("requires exact ordered five-tool discovery", () => {
    expect(() => assertExactToolDiscovery(TOOL_NAMES)).not.toThrow();
    expect(() => assertExactToolDiscovery(TOOL_NAMES.slice(0, 4))).toThrow(
      "five public tools",
    );
    expect(() =>
      assertExactToolDiscovery([...TOOL_NAMES].toReversed()),
    ).toThrow("five public tools");
  });

  it("accepts only Browser-backed reviewed proof without publication", () => {
    const receipt = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        terminalPhase: "reviewed",
        browserPreview: true,
        publicationAttempted: false,
        ...overrides,
      });
    expect(
      parseReviewedProof(receipt(), "sandbox-existing-iteration"),
    ).toMatchObject({
      eval: "sandbox-existing-iteration",
      terminalPhase: "reviewed",
    });
    for (const invalid of [
      receipt({ terminalPhase: "validated" }),
      receipt({ browserPreview: false }),
      receipt({ publicationAttempted: true }),
      "no structural receipt",
    ])
      expect(() =>
        parseReviewedProof(invalid, "sandbox-reviewed-change-set"),
      ).toThrow("reviewed proof receipt");
  });
});
