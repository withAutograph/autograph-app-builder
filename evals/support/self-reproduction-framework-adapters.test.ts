import { describe, expect, it, vi } from "vitest";
import { createDefaultFrameworkAdapter } from "./self-reproduction-framework-adapters";

const source = [
  {
    content: "export default function Page(){return <main data-app-shell />}",
    path: "app/page.tsx",
  },
  {
    content:
      "export const instant=true; export default function Layout({children}){return <body>{children}</body>}",
    path: "app/layout.tsx",
  },
  { content: "export default function Loading(){return <p>Loading</p>}", path: "app/loading.tsx" },
  { content: '"use server"; export async function save(userId:string){}', path: "app/actions.ts" },
  { content: "export default {cacheComponents:true}", path: "next.config.ts" },
  { content: ":root{--background:#fff;--foreground:#111}", path: "app/globals.css" },
];

describe("default framework adapter", () => {
  it("does not infer missing functionality from an incomplete source inventory", async () => {
    const adapter = createDefaultFrameworkAdapter({
      baseURL: "http://candidate",
      files: [],
      side: "candidate",
    });
    await expect(adapter.reviewSource("cache-components")).resolves.toMatchObject({
      disposition: "not-run",
      ready: false,
    });
  });

  it("keeps instant navigation unassessed without distinct semantic selectors", async () => {
    const adapter = createDefaultFrameworkAdapter({
      baseURL: "http://candidate",
      files: source,
      side: "candidate",
    });
    await expect(adapter.instantNavigationRecipe()).resolves.toMatchObject({
      disposition: "not-run",
      ready: false,
    });
  });

  it.each([
    "server-first",
    "narrow-client",
    "server-writes",
    "semantic-tokens",
    "suspense",
  ] as const)("does not award %s assertions from structural hints", async (requirement) => {
    const adapter = createDefaultFrameworkAdapter({
      baseURL: "http://reference",
      files: source,
      side: "reference",
    });
    expect(await adapter.reviewSource(requirement)).toMatchObject({
      disposition: "not-run",
      ready: false,
    });
    const page = { goto: vi.fn() };
    expect(await adapter.exerciseBrowser(page as never, requirement)).toMatchObject({
      assertions: [],
      disposition: "not-run",
    });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("uses explicit evaluator-owned reviews and fixtures", async () => {
    const sourceReview = vi.fn().mockResolvedValue({
      artifacts: [],
      assertions: [],
      ready: true,
      reason: "Reviewed actual import graph",
    });
    const browserFixture = vi
      .fn()
      .mockResolvedValue({ artifacts: [], assertions: [], reason: "Exercised request" });
    const adapter = createDefaultFrameworkAdapter({
      baseURL: "http://candidate",
      browserFixture,
      files: source,
      side: "candidate",
      sourceReview,
    });
    await adapter.reviewSource("narrow-client");
    await adapter.exerciseBrowser({} as never, "narrow-client");
    expect(sourceReview).toHaveBeenCalledWith("narrow-client");
    expect(browserFixture).toHaveBeenCalledWith({}, "narrow-client");
  });
});
