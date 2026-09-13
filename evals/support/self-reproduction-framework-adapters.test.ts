import { describe, expect, it, vi } from "vitest";
import { createDefaultFrameworkAdapter } from "./self-reproduction-framework-adapters";

const source = [
  {
    path: "app/page.tsx",
    content: "export default function Page(){return <main data-app-shell />}",
  },
  {
    path: "app/layout.tsx",
    content:
      "export const instant=true; export default function Layout({children}){return <body>{children}</body>}",
  },
  { path: "app/loading.tsx", content: "export default function Loading(){return <p>Loading</p>}" },
  { path: "app/actions.ts", content: '"use server"; export async function save(userId:string){}' },
  { path: "next.config.ts", content: "export default {cacheComponents:true}" },
  { path: "app/globals.css", content: ":root{--background:#fff;--foreground:#111}" },
];

describe("default framework adapter", () => {
  it("does not infer missing functionality from an incomplete source inventory", async () => {
    const adapter = createDefaultFrameworkAdapter({
      side: "candidate",
      files: [],
      baseURL: "http://candidate",
    });
    await expect(adapter.reviewSource("cache-components")).resolves.toMatchObject({
      ready: false,
      disposition: "not-run",
    });
  });

  it("keeps instant navigation unassessed without distinct semantic selectors", async () => {
    const adapter = createDefaultFrameworkAdapter({
      side: "candidate",
      files: source,
      baseURL: "http://candidate",
    });
    await expect(adapter.instantNavigationRecipe()).resolves.toMatchObject({
      ready: false,
      disposition: "not-run",
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
      side: "reference",
      files: source,
      baseURL: "http://reference",
    });
    expect(await adapter.reviewSource(requirement)).toMatchObject({
      ready: false,
      disposition: "not-run",
    });
    const page = { goto: vi.fn() };
    expect(await adapter.exerciseBrowser(page as never, requirement)).toMatchObject({
      disposition: "not-run",
      assertions: [],
    });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("uses explicit evaluator-owned reviews and fixtures", async () => {
    const sourceReview = vi.fn().mockResolvedValue({
      ready: true,
      reason: "Reviewed actual import graph",
      assertions: [],
      artifacts: [],
    });
    const browserFixture = vi
      .fn()
      .mockResolvedValue({ reason: "Exercised request", assertions: [], artifacts: [] });
    const adapter = createDefaultFrameworkAdapter({
      side: "candidate",
      files: source,
      baseURL: "http://candidate",
      sourceReview,
      browserFixture,
    });
    await adapter.reviewSource("narrow-client");
    await adapter.exerciseBrowser({} as never, "narrow-client");
    expect(sourceReview).toHaveBeenCalledWith("narrow-client");
    expect(browserFixture).toHaveBeenCalledWith({}, "narrow-client");
  });
});
