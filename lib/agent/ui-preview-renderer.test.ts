import { runInNewContext } from "node:vm";

import postcss from "postcss";
import { describe, expect, it, vi } from "vitest";

import type { UiPreviewInput } from "./ui-preview";
import { uiPreviewRendererFiles } from "./ui-preview-renderer";

describe("preview runtime initialization", () => {
  it.each([true, false])(
    "initializes charts only when used (%s)",
    (usesCharts) => {
      const input = {
        appId: "chart-review",
        catalogGaps: [],
        files: [],
        manifest: {
          productionCompositions: [
            {
              name: usesCharts ? "DonutChart" : "SchemaFormComposition",
              source: "@autograph/compositions",
            },
          ],
          screens: [
            { route: "/", entry: "overview.tsx" },
            { route: "/details", entry: "details.tsx" },
          ],
        },
        routes: ["/", "/details"],
      } as unknown as UiPreviewInput;
      const entry = uiPreviewRendererFiles(input).files.find(
        (file) => file.path === "entry.tsx"
      )!.content;
      expect(entry.includes("import { bootstrapAgCharts }")).toBe(usesCharts);
      const initialized = vi.fn();
      const render = vi.fn();
      const overview = () => null;
      const details = () => null;
      const location = { hash: "" };
      let navigate: () => void = () => {};

      // Supply imports at the execution boundary; exercise the generated entry's
      // initialization and routing, without mounting a DOM or calling providers.
      runInNewContext(entry.replaceAll(/^import .*;\n/gmu, ""), {
        React: { createElement: (component: unknown) => component },
        Screen0: overview,
        Screen1: details,
        addEventListener: (_event: string, callback: () => void) => {
          navigate = callback;
        },
        bootstrapAgCharts: initialized,
        createRoot: () => {
          if (usesCharts) {
            expect(initialized).toHaveBeenCalledExactlyOnceWith({
              allowMissingLicense: true,
            });
          } else {
            expect(initialized).not.toHaveBeenCalled();
          }
          return { render };
        },
        document: { getElementById: () => ({}) },
        location,
      });

      expect(render).toHaveBeenLastCalledWith(overview);
      location.hash = "#/details";
      navigate();
      expect(render).toHaveBeenLastCalledWith(details);
      expect(initialized).toHaveBeenCalledTimes(usesCharts ? 1 : 0);
    }
  );
});

describe("preview stylesheet provenance", () => {
  it("keeps an inline map tied to the exact theme input and separates bundle CSS", async () => {
    const themeCss = ".origin { color: rgb(12, 34, 56); }\n";
    const output = await postcss([
      {
        Once(stylesheet) {
          stylesheet.append({ name: "source", params: '".builder-preview"' });
        },
        postcssPlugin: "preview-sources",
      },
    ]).process(themeCss, {
      from: "/reference/theme.css",
      map: { annotation: true, inline: true, sourcesContent: true },
    });
    const sourceMap = output.css.match(
      /sourceMappingURL=data:application\/json[^,]*,([^*]+?)\s*\*\//u
    )?.[1];
    expect(sourceMap).toBeDefined();
    const map = JSON.parse(
      Buffer.from(sourceMap!, "base64").toString("utf-8")
    ) as { sourcesContent?: (string | null)[] };
    expect(map.sourcesContent).toContain(themeCss);
    expect(map.sourcesContent).not.toContain(
      `${themeCss}\n@source ".builder-preview";`
    );

    const input = {
      appId: "style-map-review",
      catalogGaps: [],
      files: [],
      manifest: {
        productionCompositions: [],
        screens: [{ route: "/", entry: "page.tsx" }],
      },
      routes: ["/"],
    } as unknown as UiPreviewInput;
    const renderer = uiPreviewRendererFiles(input).files.find(
      (file) => file.path === "render.mts"
    )!.content;
    expect(renderer).toContain(".process(themeCss, {");
    expect(renderer).toContain(
      "map: { inline: true, annotation: true, sourcesContent: true }"
    );
    expect(renderer).toContain('stylesheet.append({ name: "source"');
    expect(renderer).not.toContain('themeCss + "\\n@source "');
    expect(renderer).toContain("const themeStyle = css.css.replace");
    expect(renderer).toContain("const bundledStyle = bundledCss.join");
    expect(renderer).toContain("</style><style>' + bundledStyle");
  });
});
