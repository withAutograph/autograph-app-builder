import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import type { UiPreviewInput } from "./ui-preview";
import { uiPreviewRendererFiles } from "./ui-preview-renderer";

describe("preview runtime initialization", () => {
  it.each([true, false])(
    "initializes charts only when used (%s)",
    (usesCharts) => {
      const input = {
        appId: "chart-review",
        routes: ["/", "/details"],
        files: [],
        catalogGaps: [],
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
      } as unknown as UiPreviewInput;
      const entry = uiPreviewRendererFiles(input).files.find(
        (file) => file.path === "entry.tsx",
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
      runInNewContext(entry.replace(/^import .*;\n/gmu, ""), {
        Screen0: overview,
        Screen1: details,
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
        React: { createElement: (component: unknown) => component },
        document: { getElementById: () => ({}) },
        location,
        addEventListener: (_event: string, callback: () => void) => {
          navigate = callback;
        },
      });

      expect(render).toHaveBeenLastCalledWith(overview);
      location.hash = "#/details";
      navigate();
      expect(render).toHaveBeenLastCalledWith(details);
      expect(initialized).toHaveBeenCalledTimes(usesCharts ? 1 : 0);
    },
  );
});
