import { describe, expect, it } from "vitest";

import {
  canInspectExistingApplication,
  existingRepositoryAcquisitionReceipt,
} from "./existing-app-sequencing";
import type { SourceWorkflowState } from "./source-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

const receipt = {
  version: 3 as const,
  sourceKind: "existing-repository" as const,
  sourcePath: "/source",
  sourceSha: "1".repeat(40),
  sourceTree: "2".repeat(40),
  adapter: "arrusted-development-v0" as const,
  eligibilityDigest: "3".repeat(64),
  contractDigest: "4".repeat(64),
  releaseEnabled: false as const,
  digest: "5".repeat(64),
};

describe("existing-app sequencing", () => {
  it("does not expose inspection before workspace preparation", () => {
    expect(
      canInspectExistingApplication({
        version: 15,
        phase: "empty",
      } as AppBuilderWorkflowState),
    ).toBe(false);
    expect(
      canInspectExistingApplication({
        version: 15,
        phase: "prepared",
      } as AppBuilderWorkflowState),
    ).toBe(true);
  });

  it("passes an exact existing-repository receipt through without approval", () => {
    const state = {
      version: 3,
      phase: "reviewed",
      receipt,
    } satisfies SourceWorkflowState;
    expect(existingRepositoryAcquisitionReceipt(state, receipt.digest)).toEqual(
      receipt,
    );
    expect(() =>
      existingRepositoryAcquisitionReceipt(state, "0".repeat(64)),
    ).toThrow("does not match");
  });
});
