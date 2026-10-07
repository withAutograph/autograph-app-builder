import { describe, expect, it } from "vitest";

import { completionGuidance } from "./completion-guidance";

describe("shared app delivery guidance", () => {
  it("recovers accepted existing-app designs by planning exact edits before build approval", () => {
    for (const phase of [
      "app_spec_accepted",
      "dependencies_prepared",
      "identity_resolved",
    ] as const) {
      const guidance = completionGuidance({ phase });
      expect(guidance).toContain("accept_app_spec");
      expect(guidance).toContain("existingAppChanges");
      expect(guidance).toContain("before requesting build approval");
    }
  });
  it("continues an applied implementation into validation", () => {
    const result = completionGuidance({ phase: "applied" });
    expect(result).toContain("They have not passed repository validation");
    expect(result).toContain("Call validate_app_creation next");
  });

  it("keeps command success distinct from product verification", () => {
    const result = completionGuidance({ phase: "validated" });
    expect(result).toContain("Repository commands passed");
    expect(result).toContain("Product behavior and a working app preview are not established");
    expect(result).not.toContain("They have not passed repository validation");
  });

  it("uses actual diagnostics for a failed validation without asking for renewed build approval", () => {
    expect(completionGuidance({ phase: "validation_failed" })).toContain(
      "Repair the reported diagnostics with corrected implementationFiles and retry validate_app_creation in the same approved checkout",
    );
  });

  it("requires operation, cause, impact, and repair in failure reports", () => {
    const guidance = completionGuidance({ phase: "apply_failed" });
    expect(guidance).toContain("report the exact operation");
    expect(guidance).toContain("concrete error or command diagnostic");
    expect(guidance).toContain("supported next repair action");
    expect(guidance).toContain("Never replace a specific failure with a generic statement");
  });
  it("keeps app-owned authenticated migration failures executable while preserving external approval boundaries", () => {
    const guidance = completionGuidance({ phase: "validation_failed" });
    expect(guidance).toContain("App-owned data adapters, actions, obsolete demo/reset paths");
    expect(guidance).toContain("not an external blocker");
    expect(guidance).toContain("complete the typed integration in the same private checkout");
    expect(guidance).toContain("re-running the same failing tests does not complete this work");
    expect(guidance).toContain("new outward effect");
    expect(guidance).toContain("public question or approval");
  });

  it("does not promote fixture previews or publication state into working product proof", () => {
    expect(completionGuidance({ phase: "ui_previewed" })).toContain(
      "Fixture interactions do not prove",
    );
    const published = completionGuidance({ phase: "published_local" });
    expect(published).toContain("this phase alone is not proof of working product behavior");
    expect(published).toContain("Never invent localhost:<port>");
    expect(published).toContain(
      "An empty destination does not prove that the private sandbox contains no implementation",
    );
    expect(published).toContain("Publication requires its own approval");
  });

  it("allows later results to supersede a turn snapshot", () => {
    expect(completionGuidance({ phase: "empty" })).toContain(
      "Later tool results supersede this turn-start snapshot",
    );
  });
});
