import { describe, expect, it } from "vitest";

import {
  readHostedManagedSeedFiles,
  HOSTED_MANAGED_SKILLS_TARGET,
} from "../sandbox/hosted-managed-seeds";
import { uiPreviewInputSchema, validateUiPreview } from "./ui-preview";

const hostedGuidance = (skillPath: string): string | undefined => {
  const content = readHostedManagedSeedFiles().find(
    (file) => file.path === `${HOSTED_MANAGED_SKILLS_TARGET}/${skillPath}`,
  )?.content;
  if (content === undefined) {
    return undefined;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The loader contract explicitly permits strings and Uint8Array bytes; decode both supported representations.
  return typeof content === "string" ? content : new TextDecoder().decode(content);
};

describe("high-fidelity design guidance", () => {
  it("provides a first-preview example accepted by the unchanged preview contract", () => {
    const reference = hostedGuidance("design-app/references/ui-preview-authoring.md");
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
  });

  it.each([
    "design-app/SKILL.md",
    "design-app/references/ui-preview-authoring.md",
    "create-app/SKILL.md",
  ])("makes hosted guidance available for transfer: %s", (skillPath) => {
    expect(hostedGuidance(skillPath)?.length).toBeGreaterThan(0);
  });
});
