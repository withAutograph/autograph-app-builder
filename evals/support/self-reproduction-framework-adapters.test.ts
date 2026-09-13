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
  it("fails clear missing Next source structure", async () => {
    const adapter = createDefaultFrameworkAdapter({
      baseURL: "http://candidate",
      files: [],
      side: "candidate",
    });
    await expect(adapter.reviewSource("cache-components")).resolves.toMatchObject({
      disposition: "missing-functionality",
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

  it("records only browser assertions it can observe", async () => {
    const adapter = createDefaultFrameworkAdapter({
      baseURL: "http://reference",
      files: source,
      side: "reference",
    });
    const page = {
      goto: vi.fn(() => Promise.resolve()),
      locator: () => ({
        evaluate: () =>
          Promise.resolve({ background: "rgb(255, 255, 255)", foreground: "rgb(17, 17, 17)" }),
        textContent: () =>
          Promise.resolve(
            "A useful application shell with enough rendered content for evaluation.",
          ),
      }),
    };
    const observed = await adapter.exerciseBrowser(page as never, "server-first");
    expect(observed.assertions.map((item) => item.id)).toEqual(["useful-server-shell"]);
    expect(page.goto).toHaveBeenCalledWith("http://reference", { waitUntil: "domcontentloaded" });
  });
});
