import { describe, expect, it } from "vitest";

import { uiPreviewSourceDigest, validateUiPreview } from "./ui-preview";

const preview = {
  appId: "review-inbox",
  routes: ["/", "/requests"],
  files: [
    {
      path: "src/routes/index.tsx",
      content:
        'import { Button } from "@autograph/components"; export default function Page() { return <Button>Review</Button>; }',
    },
  ],
  catalogGaps: [],
};

describe("component-backed UI preview policy", () => {
  it("accepts public Arrusted imports and gives equivalent source one revision", () => {
    expect(() => validateUiPreview(preview)).not.toThrow();
    expect(uiPreviewSourceDigest(preview)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    [
      "private component",
      'import { Hidden } from "@autograph/components/private"; export default function Page() { return null; }',
      /not public/u,
    ],
    [
      "network call",
      'export default function Page() { fetch("https://example.test"); return null; }',
      /network/u,
    ],
    [
      "replacement token",
      ":root { --new-token: red; }",
      /replacement design tokens/u,
    ],
  ])("rejects %s", (_name, content, message) => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [{ path: "src/routes/index.tsx", content }],
      }),
    ).toThrow(message);
  });

  it("requires a catalog gap for a local workflow composition", () => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          ...preview.files,
          { path: "src/components/ReviewRail.tsx", content: "export const ReviewRail = () => null;" },
        ],
      }),
    ).toThrow(/catalog gap/u);
  });
});
