import { describe, expect, it } from "vitest";

import { uiPreviewSourceDigest, validateUiPreview } from "./ui-preview";
import { uiPreviewRendererFiles } from "./ui-preview-renderer";

const preview = {
  appId: "review-inbox",
  catalogGaps: [],
  files: [
    {
      path: "src/routes/index.tsx",
      content:
        'import { Button } from "@autograph/components"; export default function Page() { return <Button>Review</Button>; }',
    },
  ],
  manifest: {
    assumptions: [
      {
        id: "queue-first",
        statement: "Reviewers start in a queue",
        routes: ["/"],
      },
    ],
    decisions: [],
    fixtureFacts: [
      { id: "request-count", statement: "Three requests", routes: ["/"] },
    ],
    implementationNotes: [
      {
        visibleElement: "Review button",
        productionMeaning: "Begins a reviewed decision workflow",
        routes: ["/"],
      },
    ],
    openQuestions: [
      {
        id: "bulk-review",
        statement: "Should reviewers act on multiple requests?",
        routes: ["/requests"],
      },
    ],
    productionComponents: [
      { name: "Button", source: "@autograph/components" as const },
    ],
    productionCompositions: [],
    productionIcons: [],
    screens: [
      {
        id: "overview",
        title: "Review inbox",
        route: "/",
        entry: "src/routes/index.tsx",
      },
      {
        id: "requests",
        title: "Requests",
        route: "/requests",
        entry: "src/routes/index.tsx",
      },
    ],
    version: 1 as const,
  },
  routes: ["/", "/requests"],
};

describe("component-backed UI preview policy", () => {
  it("does not count TypeScript-only imports as visual components", () => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          {
            content:
              'import type { SchemaFormValue } from "@autograph/compositions"; import { Button as Action, type ButtonProps } from "@autograph/components"; export default function Page() { return <Action>Review</Action>; }',
            path: "src/routes/index.tsx",
          },
        ],
      })
    ).not.toThrow();
  });
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
        files: [{ content, path: "src/routes/index.tsx" }],
      })
    ).toThrow(message);
  });

  it("rejects replacement workflow components", () => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          ...preview.files,
          {
            content: "export const ReviewRail = () => null;",
            path: "src/components/ReviewRail.tsx",
          },
        ],
      })
    ).toThrow(/do not define replacement components/u);
  });

  it("requires every public component and composition import in the manifest", () => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          {
            content:
              'import { DataTableComposition } from "@autograph/compositions"; export default function Page() { return <DataTableComposition />; }',
            path: "src/routes/index.tsx",
          },
        ],
      })
    ).toThrow(/missing from its manifest/u);
  });

  it("binds manifest decisions and assumptions into the immutable revision", () => {
    const changed = {
      ...preview,
      manifest: {
        ...preview.manifest,
        assumptions: [
          {
            id: "queue-first",
            routes: ["/"],
            statement: "Reviewers start from an exceptions-only queue",
          },
        ],
      },
    };
    expect(uiPreviewSourceDigest(changed)).not.toBe(
      uiPreviewSourceDigest(preview)
    );
  });

  it("keeps internal context and draft behavior out of Browser transport", () => {
    const bundle = uiPreviewRendererFiles(preview);
    const html = bundle.files.find(({ path }) => path === "entry.tsx")!.content;
    expect(html).not.toContain("Context");
    expect(html).not.toContain("Draft spec");
    expect(html).not.toContain("implementationNotes");
    expect(html).not.toContain("queue-first");
  });

  it("does not make documented catalog gaps a custom-component escape hatch", () => {
    const local = {
      content:
        'import { Button } from "@autograph/components"; export const ReviewRail = () => <Button>Review</Button>;',
      path: "src/components/ReviewRail.tsx",
    };
    expect(() =>
      validateUiPreview({
        ...preview,
        catalogGaps: [
          {
            path: local.path,
            reason: "No public review-rail composition supports this workflow.",
            composes: [{ name: "Button", source: "@autograph/components" }],
            tokens: ["--color-background", "--space-4"],
          },
        ],
        files: [...preview.files, local],
      })
    ).toThrow(/existing Arrusted components/u);
  });

  it.each([
    [
      "decorative gradient",
      'export default function Page() { return <div className="bg-[linear-gradient(red,blue)]" />; }',
      /existing Arrusted components/u,
    ],
    [
      "raw replacement control",
      "export const ReviewRail = () => <button>Review</button>;",
      /existing Arrusted components/u,
    ],
  ])("rejects %s in component-backed previews", (_name, content, message) => {
    expect(() =>
      validateUiPreview({
        ...preview,
        catalogGaps: [
          {
            path: "src/components/ReviewRail.tsx",
            reason: "No public review-rail composition supports this workflow.",
            composes: [{ name: "Button", source: "@autograph/components" }],
            tokens: ["--color-background"],
          },
        ],
        files: [
          ...preview.files,
          { path: "src/components/ReviewRail.tsx", content },
        ],
      })
    ).toThrow(message);
  });
});
