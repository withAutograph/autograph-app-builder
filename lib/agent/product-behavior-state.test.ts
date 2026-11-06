import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindProductBehaviorPreview,
  captureProductBehaviorProvenance,
  currentProductBehaviorEvidence,
  currentProductBehaviorGeneration,
  hasCurrentProductBehaviorPreview,
  invalidateProductBehaviorEvidence,
  invalidateProductBehaviorPreview,
  productBehaviorEvidenceState,
  productBehaviorInvalidationsState,
  recordProductBehaviorEvidence,
} from "./product-behavior-state";
import type { ProductBehaviorEvidence } from "./product-behavior-state";

vi.mock("eve/context", () => ({
  defineState: (_name: string, initial: () => unknown) => {
    let value = initial();
    return {
      get: () => value,
      update: (change: (current: unknown) => unknown) => {
        value = change(value);
      },
    };
  },
}));

const observation = (status: "passed" | "failed" | "blocked"): ProductBehaviorEvidence => ({
  acceptedOutcomeText: "Save draft and read it back.",
  appSpecDigest: "spec",
  applyDigest: "apply",
  observedAt: "2026-09-29T10:00:00.000Z",
  provenance: captureProductBehaviorProvenance("started"),
  result: {
    coverage: "action-readback-only",
    outcomeId: "draft",
    reason: "Sanitized observation result.",
    status,
    unassessed: ["restart-durability", "authentication", "tenant-isolation"],
  },
});

const current = () => currentProductBehaviorEvidence("spec", "apply");

describe("behavior observation history and current eligibility", () => {
  beforeEach(() => {
    productBehaviorEvidenceState.update(() => []);
    invalidateProductBehaviorEvidence("source-apply");
    productBehaviorInvalidationsState.update(() => []);
  });
  it("requires a successful startup binding and rejects an old command", () => {
    expect(hasCurrentProductBehaviorPreview("old")).toBe(false);
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    expect(hasCurrentProductBehaviorPreview("started")).toBe(true);
    expect(hasCurrentProductBehaviorPreview("old")).toBe(false);
  });
  it.each(["source-apply", "source-repair"] as const)(
    "retains all verdicts after %s, without crediting matching digests again",
    (reason) => {
      bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
      const observations = [observation("passed"), observation("failed"), observation("blocked")];
      for (const item of observations) {
        recordProductBehaviorEvidence(item);
      }
      expect(current()).toEqual(observations);
      invalidateProductBehaviorEvidence(reason);
      expect(hasCurrentProductBehaviorPreview("started")).toBe(false);
      bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
      expect(current()).toEqual([]);
      expect(productBehaviorEvidenceState.get()).toEqual(observations);
      expect(productBehaviorInvalidationsState.get()).toEqual([
        expect.objectContaining({ reason }),
      ]);
      const retry = observation("passed");
      recordProductBehaviorEvidence(retry);
      expect(current()).toEqual([retry]);
      expect(productBehaviorEvidenceState.get()).toEqual([...observations, retry]);
    },
  );
  it("retains observations completed after an implementation repair as historical only", () => {
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    const pending = observation("failed");
    invalidateProductBehaviorEvidence("source-repair");
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    recordProductBehaviorEvidence(pending);
    expect(current()).toEqual([]);
    expect(productBehaviorEvidenceState.get()).toEqual([pending]);
  });
  it("preserves current credit on same-command reuse but not command replacement and reuse", () => {
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    const result = observation("passed");
    recordProductBehaviorEvidence(result);
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    expect(current()).toEqual([result]);
    expect(productBehaviorInvalidationsState.get()).toEqual([]);
    bindProductBehaviorPreview("replacement", currentProductBehaviorGeneration());
    expect(current()).toEqual([]);
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    expect(current()).toEqual([]);
    expect(productBehaviorEvidenceState.get()).toEqual([result]);
  });
  it.each(["preview-replaced", "preview-released"] as const)(
    "invalidates before %s even when no replacement starts successfully",
    (reason) => {
      bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
      const pending = observation("passed");
      invalidateProductBehaviorPreview(reason);
      recordProductBehaviorEvidence(pending);
      expect(current()).toEqual([]);
      expect(hasCurrentProductBehaviorPreview("started")).toBe(false);
      bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
      expect(current()).toEqual([]);
      expect(productBehaviorEvidenceState.get()).toEqual([pending]);
    },
  );
  it("does not credit or overwrite the new binding with a startup spanning source writes", () => {
    const startedGeneration = currentProductBehaviorGeneration();
    invalidateProductBehaviorEvidence("source-repair");
    bindProductBehaviorPreview("current", currentProductBehaviorGeneration());
    bindProductBehaviorPreview("late-start", startedGeneration);
    expect(hasCurrentProductBehaviorPreview("late-start")).toBe(false);
    expect(hasCurrentProductBehaviorPreview("current")).toBe(true);
  });
  it("retains legacy observations with no provenance without granting them current credit", () => {
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    const legacy = observation("passed");
    delete legacy.provenance;
    recordProductBehaviorEvidence(legacy);
    expect(current()).toEqual([]);
    expect(productBehaviorEvidenceState.get()).toEqual([legacy]);
  });
  it("requires matching accepted specification and apply receipts", () => {
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    recordProductBehaviorEvidence(observation("passed"));
    expect(currentProductBehaviorEvidence("other", "apply")).toEqual([]);
    expect(currentProductBehaviorEvidence("spec", "other")).toEqual([]);
  });
});
