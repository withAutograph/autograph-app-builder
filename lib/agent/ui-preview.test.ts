import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  publicPreviewIcons,
  uiPreviewInputSchema,
  uiPreviewSourceDigest,
  stageUiPreviewSourceChunk,
  validateUiPreview,
} from "./ui-preview";
import { uiPreviewRendererFiles } from "./ui-preview-renderer";

const preview = {
  appId: "review-inbox",
  catalogGaps: [],
  files: [
    {
      content:
        'import { Button } from "@autograph/components"; export default function Page() { return <Button>Review</Button>; }',
      path: "src/routes/index.tsx",
    },
  ],
  manifest: {
    assumptions: [
      {
        id: "queue-first",
        routes: ["/"],
        statement: "Reviewers start in a queue",
      },
    ],
    decisions: [],
    fixtureFacts: [{ id: "request-count", routes: ["/"], statement: "Three requests" }],
    implementationNotes: [
      {
        productionMeaning: "Begins a reviewed decision workflow",
        routes: ["/"],
        visibleElement: "Review button",
      },
    ],
    openQuestions: [
      {
        id: "bulk-review",
        routes: ["/requests"],
        statement: "Should reviewers act on multiple requests?",
      },
    ],
    productionComponents: [{ name: "Button", source: "@autograph/components" as const }],
    productionCompositions: [],
    productionIcons: [],
    screens: [
      {
        entry: "src/routes/index.tsx",
        id: "overview",
        route: "/",
        title: "Review inbox",
      },
      {
        entry: "src/routes/index.tsx",
        id: "requests",
        route: "/requests",
        title: "Requests",
      },
    ],
    version: 1 as const,
  },
  routes: ["/", "/requests"],
};

describe("component-backed UI preview policy", () => {
  it("stages a preview source bundle larger than one event and preserves the single-call digest", () => {
    const content = `import { Button } from "@autograph/components"; export default function Page() { return <Button>Review</Button>; }\n/*${"x".repeat(11 * 1024 * 1024)}*/`;
    const sourceFile = {
      digest: createHash("sha256").update(content).digest("hex"),
      path: "src/routes/index.tsx",
      sizeBytes: Buffer.byteLength(content, "utf-8"),
    };
    const metadata = {
      ...preview,
      files: [{ content: "placeholder", path: sourceFile.path }],
      sourceFiles: [sourceFile],
    };
    const firstContent = content.slice(0, 6 * 1024 * 1024);
    const first = stageUiPreviewSourceChunk({
      callId: "chunk-0",
      value: {
        ...metadata,
        files: [{ content: firstContent, path: sourceFile.path }],
        sourceChunk: { chunkIndex: 0, filePath: sourceFile.path, offsetBytes: 0 },
      },
    });
    expect(first.receipt.complete).toBe(false);
    const transferred = first.transfer;
    if (transferred === undefined) {
      throw new Error("Expected incomplete transfer state.");
    }
    const replay = stageUiPreviewSourceChunk({
      callId: "chunk-0",
      current: transferred,
      value: {
        ...metadata,
        files: [{ content: firstContent, path: sourceFile.path }],
        sourceChunk: { chunkIndex: 0, filePath: sourceFile.path, offsetBytes: 0 },
      },
    });
    expect(replay.receipt).toEqual(first.receipt);
    const rest = content.slice(firstContent.length);
    const complete = stageUiPreviewSourceChunk({
      callId: "chunk-1",
      current: transferred,
      value: {
        ...metadata,
        files: [{ content: rest, path: sourceFile.path }],
        sourceChunk: {
          chunkIndex: 1,
          filePath: sourceFile.path,
          offsetBytes: Buffer.byteLength(firstContent, "utf-8"),
          transferId: first.receipt.transferId,
          transferRevision: first.receipt.transferRevision,
        },
      },
    });
    expect(complete.receipt.complete).toBe(true);
    expect(complete.completeInput).toBeDefined();
    expect(complete.receipt.sourceDigest).toBe(
      uiPreviewSourceDigest({ ...preview, files: [{ content, path: sourceFile.path }] }),
    );
  });

  it("rejects out-of-order, stale-revision, and altered-digest source chunks", () => {
    const content = "export default function Page() { return null; }";
    const sourceFiles = [
      {
        digest: createHash("sha256").update(content).digest("hex"),
        path: "src/routes/index.tsx",
        sizeBytes: Buffer.byteLength(content),
      },
    ];
    const base = {
      ...preview,
      files: [{ content: content.slice(0, 10), path: sourceFiles[0].path }],
      sourceFiles,
    };
    const started = stageUiPreviewSourceChunk({
      callId: "first",
      value: {
        ...base,
        sourceChunk: { chunkIndex: 0, filePath: sourceFiles[0].path, offsetBytes: 0 },
      },
    });
    const current = started.transfer;
    if (current === undefined) {
      throw new Error("Expected incomplete transfer state.");
    }
    const next = {
      ...base,
      files: [{ content: content.slice(10), path: sourceFiles[0].path }],
      sourceChunk: {
        chunkIndex: 1,
        filePath: sourceFiles[0].path,
        offsetBytes: 10,
        transferId: started.receipt.transferId,
        transferRevision: started.receipt.transferRevision,
      },
    };
    expect(() =>
      stageUiPreviewSourceChunk({
        callId: "gap",
        current,
        value: { ...next, sourceChunk: { ...next.sourceChunk, chunkIndex: 2 } },
      }),
    ).toThrow(/in order/u);
    expect(() =>
      stageUiPreviewSourceChunk({
        callId: "stale",
        current,
        value: { ...next, sourceChunk: { ...next.sourceChunk, transferRevision: "0".repeat(64) } },
      }),
    ).toThrow(/stale/u);
    const alteredRemainder = content.slice(10).replace(/^./u, "x");
    expect(() =>
      stageUiPreviewSourceChunk({
        callId: "altered",
        current,
        value: { ...next, files: [{ content: alteredRemainder, path: sourceFiles[0].path }] },
      }),
    ).toThrow(/digest/u);
  });
  it("accepts more than the former file, per-file, and route-count ceilings", () => {
    const files = Array.from({ length: 33 }, (_, index) => ({
      content: `export const File${index} = "${"x".repeat(262_145)}";`,
      path: `src/routes/page-${index}.tsx`,
    }));
    const routes = Array.from({ length: 17 }, (_, index) => `/route-${index}`);
    const screens = Array.from({ length: 17 }, (_, index) => ({
      entry: `src/routes/page-${index}.tsx`,
      id: `screen-${index}`,
      route: `/route-${index}`,
      title: `Screen ${index}`,
    }));
    expect(
      uiPreviewInputSchema.safeParse({
        ...preview,
        files,
        manifest: { ...preview.manifest, screens },
        routes,
      }).success,
    ).toBe(true);
  });

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
      }),
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
    ["replacement token", ":root { --new-token: red; }", /replacement design tokens/u],
  ])("rejects %s", (_name, content, message) => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [{ content, path: "src/routes/index.tsx" }],
      }),
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
      }),
    ).toThrow(/do not define replacement components/u);
  });

  it.each(["button", "input", "select", "textarea", "dialog", "table"])(
    "rejects a raw %s control even when defined directly in a route",
    (tag) => {
      expect(() =>
        validateUiPreview({
          ...preview,
          files: [
            {
              content: `export default function Page() { return <${tag} />; }`,
              path: "src/routes/index.tsx",
            },
          ],
        }),
      ).toThrow(new Error("Local workflow components must compose public Arrusted primitives."));
    },
  );

  it("rejects buttonClassName as an unlisted public catalog import", () => {
    const helperPreview = {
      ...preview,
      files: [
        {
          content:
            'import { buttonClassName } from "@autograph/components"; export default function Page() { return <a className={buttonClassName()} href="/requests">Review</a>; }',
          path: "src/routes/index.tsx",
        },
      ],
    };

    expect(() => validateUiPreview(helperPreview)).toThrow(
      new Error(
        "UI preview catalog import is missing from its manifest: @autograph/components#buttonClassName",
      ),
    );

    const result = uiPreviewInputSchema.safeParse({
      ...helperPreview,
      manifest: {
        ...helperPreview.manifest,
        productionComponents: [
          ...helperPreview.manifest.productionComponents,
          { name: "buttonClassName", source: "@autograph/components" },
        ],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: "invalid_format",
          path: ["manifest", "productionComponents", 1, "name"],
        }),
      ]);
    }
  });

  it("accepts route composition using a public Button and local fixture state", () => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          {
            content: `import { useState } from "react";
import { Button } from "@autograph/components";
export default function Page() {
  const [remaining, setRemaining] = useState(3);
  return <section>
    <p>{remaining} requests awaiting review</p>
    <Button disabled={remaining === 0} onClick={() => setRemaining(remaining - 1)}>Review next</Button>
  </section>;
}`,
            path: "src/routes/index.tsx",
          },
        ],
      }),
    ).not.toThrow();
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
      }),
    ).toThrow(/missing from its manifest/u);
  });

  it("rejects invented icons with the exact public inventory", () => {
    expect(publicPreviewIcons).toContain("ChevronLeft");
    expect(publicPreviewIcons).not.toContain("ArrowLeft");
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          {
            content:
              'import { ArrowLeft } from "@autograph/icons"; export default function Page() { return <ArrowLeft />; }',
            path: "src/routes/index.tsx",
          },
        ],
        manifest: {
          ...preview.manifest,
          productionComponents: [],
          productionIcons: [{ name: "ArrowLeft", source: "@autograph/icons" }],
        },
      }),
    ).toThrow(/not a public @autograph\/icons export.*ChevronLeft/u);
  });

  it("accepts valid single-line JSX regardless of formatting", () => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          {
            content: `export default function Page() { return <main>${"x".repeat(2100)}</main>; }`,
            path: "src/routes/index.tsx",
          },
        ],
        manifest: { ...preview.manifest, productionComponents: [] },
      }),
    ).not.toThrow();
  });

  it("still rejects forbidden controls in long-line JSX", () => {
    expect(() =>
      validateUiPreview({
        ...preview,
        files: [
          {
            content: `export default function Page() { return <main>${"x".repeat(2100)}<button>Submit</button></main>; }`,
            path: "src/routes/index.tsx",
          },
        ],
        manifest: { ...preview.manifest, productionComponents: [] },
      }),
    ).toThrow(/public Arrusted primitives/u);
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
    expect(uiPreviewSourceDigest(changed)).not.toBe(uiPreviewSourceDigest(preview));
  });

  it("keeps internal context and draft behavior out of Browser transport", () => {
    const bundle = uiPreviewRendererFiles(preview);
    const html = bundle.files.find(({ path }) => path === "entry.tsx")?.content;
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
            composes: [{ name: "Button", source: "@autograph/components" }],
            path: local.path,
            reason: "No public review-rail composition supports this workflow.",
            tokens: ["--color-background", "--space-4"],
          },
        ],
        files: [...preview.files, local],
      }),
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
            composes: [{ name: "Button", source: "@autograph/components" }],
            path: "src/components/ReviewRail.tsx",
            reason: "No public review-rail composition supports this workflow.",
            tokens: ["--color-background"],
          },
        ],
        files: [...preview.files, { content, path: "src/components/ReviewRail.tsx" }],
      }),
    ).toThrow(message);
  });
});
