import { describe, expect, it } from "vitest";
import { productAcceptanceObligations } from "./product-acceptance";

describe("accepted product obligations", () => {
  it("retains concrete outcomes and readbacks without treating them as executed", () => {
    const walkthrough =
      "1. Save a draft, restart, and read the saved server record.\n2. Create a child app and complete its first task.";
    const result = productAcceptanceObligations({
      content: `# App\n## Acceptance walkthrough\n${walkthrough}\n## Build handoff\n{}\n`,
      digest: "accepted-spec",
    });
    expect(result.walkthrough).toBe(walkthrough);
    expect(result.implementationPrompt).toContain(walkthrough);
    expect(result.implementationPrompt).not.toContain("Build handoff");
    expect(result).toMatchObject({
      productStatus: "unassessed",
      appSpecDigest: "accepted-spec",
      evidence: [],
    });
  });
  it("does not invent obligations when the section is absent", () => {
    expect(
      productAcceptanceObligations({ content: "# Static prototype", digest: "spec" }),
    ).toMatchObject({ walkthrough: "", productStatus: "unassessed" });
  });
  it("preserves executable examples containing markdown headings", () => {
    const result = productAcceptanceObligations({
      content:
        "## Acceptance walkthrough\n```text\n## Visible heading\n```\nVerify server readback.\n## Build handoff\n{}",
      digest: "spec",
    });
    expect(result.walkthrough).toContain("## Visible heading");
    expect(result.walkthrough).toContain("Verify server readback.");
  });
});
