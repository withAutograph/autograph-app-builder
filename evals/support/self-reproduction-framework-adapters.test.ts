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
  it("fails clear missing Next source structure", async () => {
    const adapter = createDefaultFrameworkAdapter({
      side: "candidate",
      files: [],
      baseURL: "http://candidate",
    });
    await expect(adapter.reviewSource("cache-components")).resolves.toMatchObject({
      ready: false,
      disposition: "missing-functionality",
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

  it("records only browser assertions it can observe", async () => {
    const adapter = createDefaultFrameworkAdapter({
      side: "reference",
      files: source,
      baseURL: "http://reference",
    });
    const page = {
      goto: vi.fn(() => Promise.resolve()),
      locator: () => ({
        textContent: () =>
          Promise.resolve(
            "A useful application shell with enough rendered content for evaluation.",
          ),
        evaluate: () =>
          Promise.resolve({ background: "rgb(255, 255, 255)", foreground: "rgb(17, 17, 17)" }),
      }),
    };
    const observed = await adapter.exerciseBrowser(page as never, "server-first");
    expect(observed.assertions.map((item) => item.id)).toEqual(["useful-server-shell"]);
    expect(page.goto).toHaveBeenCalledWith("http://reference", { waitUntil: "domcontentloaded" });
  });
});
