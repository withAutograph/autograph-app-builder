import { describe, expect, it, vi } from "vitest";

import { planAcceptedAppSpec } from "./accepted-spec-planning";

describe("planAcceptedAppSpec", () => {
  it("continues an accepted non-vendor Stock Exceptions design without model tool selection", async () => {
    const plan = vi.fn(async () => {});
    await planAcceptedAppSpec({
      phase: "app_spec_accepted",
      plan,
      planComplete: false,
    });

    expect(plan).toHaveBeenCalledOnce();
  });

  it("does not invoke planning again after the accepted design is already planned", async () => {
    const plan = vi.fn(async () => {});

    await planAcceptedAppSpec({
      phase: "planned",
      plan,
      planComplete: true,
    });

    expect(plan).not.toHaveBeenCalled();
  });
});
