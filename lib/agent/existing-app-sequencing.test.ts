import { describe, expect, it } from "vitest";

import {
  canInspectExistingApplication,
  existingRepositoryAcquisitionReceipt,
} from "./existing-app-sequencing";
import type { SourceWorkflowState } from "./source-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

const receipt = {
  adapter: "arrusted-development-v0" as const,
  contractDigest: "4".repeat(64),
  digest: "5".repeat(64),
  eligibilityDigest: "3".repeat(64),
  releaseEnabled: false as const,
  sourceKind: "existing-repository" as const,
  sourcePath: "/source",
  sourceSha: "1".repeat(40),
  sourceTree: "2".repeat(40),
  version: 3 as const,
};

describe("existing-app sequencing", () => {
  it("does not expose inspection before workspace preparation", () => {
    expect(
      canInspectExistingApplication({
        phase: "empty",
        version: 17,
      } as AppBuilderWorkflowState)
    ).toBe(false);
    expect(
      canInspectExistingApplication({
        phase: "prepared",
        version: 17,
      } as AppBuilderWorkflowState)
    ).toBe(true);
  });

  it("passes an exact existing-repository receipt through without approval", () => {
    const state = {
      phase: "reviewed",
      receipt,
      version: 3,
    } satisfies SourceWorkflowState;
    expect(existingRepositoryAcquisitionReceipt(state, receipt.digest)).toEqual(
      receipt
    );
    expect(() =>
      existingRepositoryAcquisitionReceipt(state, "0".repeat(64))
    ).toThrow("does not match");
  });
});
