import { describe, expect, it } from "vitest";

import {
  readHostedManagedSeedFiles,
  HOSTED_MANAGED_SKILLS_TARGET,
} from "../sandbox/hosted-managed-seeds";
import { uiPreviewInputSchema, validateUiPreview } from "./ui-preview";

describe("high-fidelity design guidance", () => {
  it("provides a first-preview example accepted by the unchanged preview contract", () => {
    const reference = readHostedManagedSeedFiles()
      .find(
        (file) =>
          file.path ===
          `${HOSTED_MANAGED_SKILLS_TARGET}/design-app/references/ui-preview-authoring.md`,
      )
      ?.content.toString("utf-8");
    if (reference === undefined) {
      throw new Error("Hosted preview authoring guidance is unavailable.");
    }
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

  it.each([
    "design-app/SKILL.md",
    "design-app/references/ui-preview-authoring.md",
    "create-app/SKILL.md",
  ])("makes hosted guidance available for transfer: %s", (skillPath) => {
    const file = readHostedManagedSeedFiles().find(
      (entry) => entry.path === `${HOSTED_MANAGED_SKILLS_TARGET}/${skillPath}`,
    );
    expect(file?.content.byteLength).toBeGreaterThan(0);
  });
});
