import { describe, expect, it } from "vitest";

import {
  fallbackUiPreviewHtml,
  uiPreviewSourceDigest,
  validateUiPreview,
} from "./ui-preview";

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
  manifest: {
    version: 1 as const,
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
    productionComponents: [
      { name: "Button", source: "@autograph/components" as const },
    ],
    productionCompositions: [],
    productionIcons: [],
    fixtureFacts: [
      { id: "request-count", statement: "Three requests", routes: ["/"] },
    ],
    decisions: [],
    assumptions: [
      {
        id: "queue-first",
        statement: "Reviewers start in a queue",
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
    implementationNotes: [
      {
        visibleElement: "Review button",
        productionMeaning: "Begins a reviewed decision workflow",
        routes: ["/"],
      },
    ],
  },
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
          {
            path: "src/components/ReviewRail.tsx",
            content: "export const ReviewRail = () => null;",
          },
        ],
      }),
    ).toThrow(/catalog gap/u);
  });

  it("requires every public component and composition import in the manifest", () => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          {
            path: "src/routes/index.tsx",
            content:
              'import { DataTableComposition } from "@autograph/compositions"; export default function Page() { return <DataTableComposition />; }',
          },
        ],
      }),
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
            statement: "Reviewers start from an exceptions-only queue",
            routes: ["/"],
          },
        ],
      },
    };
    expect(uiPreviewSourceDigest(changed)).not.toBe(
      uiPreviewSourceDigest(preview),
    );
  });

  it("keeps internal context and draft behavior out of Browser transport", () => {
    const html = fallbackUiPreviewHtml(preview);
    expect(html).not.toContain("Context");
    expect(html).not.toContain("Draft spec");
    expect(html).not.toContain("implementationNotes");
    expect(html).not.toContain("queue-first");
  });

  it("requires local workflow components to document capability, primitives, and tokens", () => {
    const local = {
      path: "src/components/ReviewRail.tsx",
      content:
        'import { Button } from "@autograph/components"; export const ReviewRail = () => <Button>Review</Button>;',
    };
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [...preview.files, local],
        catalogGaps: [
          {
            path: local.path,
            reason: "No public review-rail composition supports this workflow.",
            composes: [{ name: "Button", source: "@autograph/components" }],
            tokens: ["--color-background", "--space-4"],
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "decorative gradient",
      'export default function Page() { return <div className="bg-[linear-gradient(red,blue)]" />; }',
      /decorative gradients/u,
    ],
    [
      "raw replacement control",
      "export const ReviewRail = () => <button>Review</button>;",
      /public Arrusted primitives/u,
    ],
  ])("rejects %s in component-backed previews", (_name, content, message) => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          ...preview.files,
          { path: "src/components/ReviewRail.tsx", content },
        ],
        catalogGaps: [
          {
            path: "src/components/ReviewRail.tsx",
            reason: "No public review-rail composition supports this workflow.",
            composes: [{ name: "Button", source: "@autograph/components" }],
            tokens: ["--color-background"],
          },
        ],
      }),
    ).toThrow(message);
  });
});
