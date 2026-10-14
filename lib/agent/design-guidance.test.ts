import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HOSTED_MANAGED_SKILL_CONTENTS } from "../sandbox/hosted-managed-seeds.generated";
import { uiPreviewInputSchema, validateUiPreview } from "./ui-preview";

describe("high-fidelity design guidance", () => {
  it("provides a first-preview example accepted by the unchanged preview contract", () => {
    const reference = readFileSync(
      "agent/skills/design-app/references/ui-preview-authoring.md",
      "utf-8",
    );
    const content = reference.match(/```tsx\n(?<content>[\s\S]*?)\n```/u)?.groups?.content;
    const manifest = reference.match(/```json\n(?<manifest>[\s\S]*?)\n```/u)?.groups?.manifest;
    expect(content).toBeDefined();
    expect(manifest).toBeDefined();
    if (manifest === undefined) {
      throw new Error("Expected the reference to include a JSON manifest.");
    }
    const input = uiPreviewInputSchema.parse({
      appId: "request-review",
      catalogGaps: [],
      files: [{ content, path: "src/routes/index.tsx" }],
      manifest: JSON.parse(manifest),
      routes: ["/"],
    });
    expect(() => validateUiPreview(input)).not.toThrow();

    // The example's manifest must describe actual usage, rather than masking
    // missing imports with a broad inventory of unrelated components.
    expect(() =>
      validateUiPreview({
        ...input,
        manifest: { ...input.manifest, productionComponents: [] },
      }),
    ).toThrow();
  });

  it.each(["SKILL.md", "references/ui-preview-authoring.md"])(
    "delivers the same preview guidance locally and in the hosted bundle: %s",
    (path) => {
      expect(
        HOSTED_MANAGED_SKILL_CONTENTS.find((entry) => entry.path === `design-app/${path}`)?.content,
      ).toBe(readFileSync(`agent/skills/design-app/${path}`, "utf-8"));
    },
  );

  it("delivers current build and final-review guidance in the hosted bundle", () => {
    expect(
      HOSTED_MANAGED_SKILL_CONTENTS.find((entry) => entry.path === "create-app/SKILL.md")?.content,
    ).toBe(readFileSync("agent/skills/create-app/SKILL.md", "utf-8"));
  });
});
