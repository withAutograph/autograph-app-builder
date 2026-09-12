import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HOSTED_MANAGED_SKILL_CONTENTS } from "../sandbox/hosted-managed-seeds.generated";
import { uiPreviewInputSchema, validateUiPreview } from "./ui-preview";

const skill = readFileSync("agent/skills/design-app/SKILL.md", "utf-8");
const reviewExperiences = readFileSync("docs/ui-preview-review-experiences.md", "utf-8");

describe("high-fidelity design guidance", () => {
  it("provides a first-preview example accepted by the unchanged preview contract", () => {
    const reference = readFileSync(
      "agent/skills/design-app/references/ui-preview-authoring.md",
      "utf-8",
    );
    const content = reference.match(/```tsx\n([\s\S]*?)\n```/u)?.[1];
    const manifest = reference.match(/```json\n([\s\S]*?)\n```/u)?.[1];
    expect(content).toBeDefined();
    expect(manifest).toBeDefined();
    const input = uiPreviewInputSchema.parse({
      appId: "request-review",
      routes: ["/"],
      files: [{ path: "src/routes/index.tsx", content }],
      catalogGaps: [],
      manifest: JSON.parse(manifest!),
    });
    expect(() => validateUiPreview(input)).not.toThrow();

    // The example's manifest must describe actual usage, rather than masking
    // missing imports with a broad inventory of unrelated components.
    expect(input.manifest.productionComponents).toEqual([
      { name: "Button", source: "@autograph/components" },
    ]);
    expect(() =>
      validateUiPreview({
        ...input,
        manifest: { ...input.manifest, productionComponents: [] },
      }),
    ).toThrow("@autograph/components#Button");
  });

  it.each(["SKILL.md", "references/ui-preview-authoring.md"])(
    "delivers the same preview guidance locally and in the hosted bundle: %s",
    (path) => {
      expect(
        HOSTED_MANAGED_SKILL_CONTENTS.find((entry) => entry.path === `design-app/${path}`)?.content,
      ).toBe(readFileSync(`agent/skills/design-app/${path}`, "utf-8"));
    },
  );

  it("inspects public components, compositions, stories, and consumers in order", () => {
    const evidence = [
      "public `@autograph/components` exports",
      "public `@autograph/compositions` exports",
      "relevant stories and documented examples",
      "representative production consumers",
    ].map((value) => skill.indexOf(value));
    expect(evidence.every((index) => index >= 0)).toBe(true);
    expect(evidence).toEqual([...evidence].toSorted((left, right) => left - right));
  });

  it("prefers compositions and records justified catalog gaps", () => {
    expect(skill).toContain(
      "Prefer the cheapest public composition that makes the user's decision visible.",
    );
    expect(skill).toMatch(
      /catalog\s+gap is a reason to adapt the design using available components/u,
    );
    expect(skill).toContain("Do not add local component implementations");
    expect(skill).toContain("target-owned token entrypoint directly");
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
    expect(skill).toContain("call `record_ui_preview` with React route wiring");
    expect(skill).toMatch(/never substitute a generic\s+file writer/u);
  });

  it("requires exact icon exports and repairable preview source", () => {
    const reference = readFileSync(
      "agent/skills/design-app/references/ui-preview-authoring.md",
      "utf-8",
    );
    expect(reference).toMatch(/`ChevronLeft`; `ArrowLeft` is not an\s+export/u);
    expect(reference).toContain("Keep TSX formatted with normal line breaks");
    expect(reference).toMatch(/Call `accept_ui_preview`\s+only after/u);
  });
});
