import { describe, expect, it } from "vitest";

import { completionGuidance } from "./completion-guidance";

describe("shared app delivery guidance", () => {
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
