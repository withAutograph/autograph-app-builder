import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindProductBehaviorPreview,
  clearProductBehaviorEvidence,
  currentProductBehaviorGeneration,
  hasCurrentProductBehaviorPreview,
} from "./product-behavior-state";

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

describe("preview eligibility after implementation repair", () => {
  beforeEach(() => {
    clearProductBehaviorEvidence();
  });
  it("requires a successful startup binding and rejects an old command", () => {
    expect(hasCurrentProductBehaviorPreview("old")).toBe(false);
    bindProductBehaviorPreview("started", currentProductBehaviorGeneration());
    expect(hasCurrentProductBehaviorPreview("started")).toBe(true);
    expect(hasCurrentProductBehaviorPreview("old")).toBe(false);
  });
  it("invalidates old preview on writes until normal preview startup succeeds", () => {
    bindProductBehaviorPreview("old", currentProductBehaviorGeneration());
    clearProductBehaviorEvidence();
    expect(hasCurrentProductBehaviorPreview("old")).toBe(false);
    bindProductBehaviorPreview("reopened", currentProductBehaviorGeneration());
    expect(hasCurrentProductBehaviorPreview("reopened")).toBe(true);
  });
  it("does not credit a startup spanning implementation writes", () => {
    const startedGeneration = currentProductBehaviorGeneration();
    clearProductBehaviorEvidence();
    bindProductBehaviorPreview("late-start", startedGeneration);
    expect(hasCurrentProductBehaviorPreview("late-start")).toBe(false);
  });
});
