import { describe, expect, it, vi } from "vitest";

import { ExistingApplicationChangesRequiredError } from "@/lib/repository/existing-application-changes-required-error";
import { continuePrototypePlanning } from "./existing-app-plan-recovery";

describe("existing-app prototype planning", () => {
  it("returns the exact planning continuation when an existing app needs edited files", async () => {
    const result = await continuePrototypePlanning(async () => {
      throw new ExistingApplicationChangesRequiredError();
    });
    expect(result.implementationPlanReady).toBe(false);
    expect(result.nextAction).toContain("accept_app_spec with existingAppChanges");
    expect(result.nextAction).toContain("complete replacement content");
  });

  it("keeps successful automatic planning intact", async () => {
    const plan = vi.fn(async () => undefined);
    await expect(continuePrototypePlanning(plan)).resolves.toEqual({
      implementationPlanReady: true,
    });
    expect(plan).toHaveBeenCalledOnce();
  });

  it("surfaces unrelated planning failures", async () => {
    const failure = new Error("identity command failed");
    await expect(
      continuePrototypePlanning(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
