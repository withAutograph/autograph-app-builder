import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const skill = readFileSync("agent/skills/design-app/SKILL.md", "utf8");
const reviewExperiences = readFileSync(
  "docs/ui-preview-review-experiences.md",
  "utf8",
);

describe("high-fidelity design guidance", () => {
  it("inspects public components, compositions, stories, and consumers in order", () => {
    const evidence = [
      "public `@autograph/components` exports",
      "public `@autograph/compositions` exports",
      "relevant stories and documented examples",
      "representative production consumers",
    ].map((value) => skill.indexOf(value));
    expect(evidence.every((index) => index >= 0)).toBe(true);
    expect(evidence).toEqual(
      [...evidence].toSorted((left, right) => left - right),
    );
  });

  it("prefers compositions and records justified catalog gaps", () => {
    expect(skill).toContain(
      "Prefer the cheapest public composition that makes the user's decision visible.",
    );
    expect(skill).toContain("capability-gap reason");
    expect(skill).toContain("inventoried public primitives");
    expect(skill).toContain("semantic Arrusted tokens");
  });

  it("keeps assumptions distinct and rejects common generic-design failure modes", () => {
    expect(skill).toContain("never accepted decisions");
    expect(skill).toMatch(/decorative\s+dashboard regions/u);
    expect(skill).toContain("gradients");
    expect(skill).toContain("excessive card nesting");
    expect(skill).toContain("invented iconography");
    expect(skill).toContain("unsupported design-system APIs");
  });

  it("keeps previews product-only and documents deferred review shells", () => {
    expect(reviewExperiences).toContain("pure product preview");
    expect(reviewExperiences).toContain("Optional review shell");
    expect(reviewExperiences).toContain("Persistent three-view workbench");
    expect(reviewExperiences).toMatch(/not\s+implemented/u);
    expect(skill).toContain(
      "Context, Draft spec, internal receipts, and implementation plans do not leak",
    );
  });

  it("contains no HTML-first generation phase for new previews", () => {
    expect(skill).not.toMatch(/Generate the first HTML|Minimum HTML gate/u);
    expect(skill).toContain("bounded React UI source");
    expect(skill).toMatch(/never substitute a generic\s+file writer/u);
  });
});
