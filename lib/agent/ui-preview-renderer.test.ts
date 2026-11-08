import { runInNewContext } from "node:vm";
import postcss from "postcss";
import type { Root } from "postcss";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { UiPreviewInput } from "./ui-preview";
import { workspaceBinInstallCommand } from "../repository/workspace-bin-install";
import { renderUiPreview, uiPreviewRendererFiles } from "./ui-preview-renderer";

describe("preview runtime initialization", () => {
  it.each([true, false])("initializes charts only when used (%s)", (usesCharts) => {
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
          { entry: "overview.tsx", route: "/" },
          { entry: "details.tsx", route: "/details" },
        ],
      },
      routes: ["/", "/details"],
    };
    const entryFile = uiPreviewRendererFiles(input).files.find((file) => file.path === "entry.tsx");
    if (!entryFile) {
      throw new Error("Generated preview entry is missing");
    }
    const entry = entryFile.content;
    expect(entry.includes("import { bootstrapAgCharts }")).toBe(usesCharts);
    const initialized = vi.fn();
    const render = vi.fn();
    // Keep generated-screen fixtures scoped to this test.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const overview = () => null;
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const details = () => null;
    const location = { hash: "" };
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    let navigate: () => void = () => {};

    // Supply imports at the execution boundary; exercise the generated entry's
    // initialization and routing, without mounting a DOM or calling providers.
    // oxlint-disable-next-line sonarjs/code-eval -- Execute the generated preview entry against controlled fixtures.
    runInNewContext(entry.replaceAll(/^import .*;\n/gmu, ""), {
      React: { createElement: (component: unknown) => component },
      Screen0: overview,
      Screen1: details,
      // The generated browser entrypoint uses the DOM callback contract.
      // oxlint-disable-next-line promise/prefer-await-to-callbacks
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
  });
});

const appendPreviewSource = (stylesheet: Root) => {
  stylesheet.append({ name: "source", params: '".builder-preview"' });
};

describe("preview stylesheet provenance", () => {
  it("keeps an inline map tied to the exact theme input and separates bundle CSS", async () => {
    const themeCss = ".origin { color: rgb(12, 34, 56); }\n";
    const output = await postcss([
      {
        Once: appendPreviewSource,
        postcssPlugin: "preview-sources",
      },
    ]).process(themeCss, {
      from: "/reference/theme.css",
      map: { annotation: true, inline: true, sourcesContent: true },
    });
    const sourceMap =
      /sourceMappingURL=data:application\/json[^,]*,(?<sourceMap>[^*]+?)\s*\*\//u.exec(
        output.css,
      )?.[1];
    expect(sourceMap).toBeDefined();
    if (sourceMap === undefined) {
      throw new Error("Inline source map is missing");
    }
    const map = z
      .looseObject({ sourcesContent: z.array(z.string().nullable()).optional() })
      .parse(JSON.parse(Buffer.from(sourceMap, "base64").toString("utf-8")));
    expect(map.sourcesContent).toContain(themeCss);
    expect(map.sourcesContent).not.toContain(`${themeCss}\n@source ".builder-preview";`);

    const input = {
      appId: "style-map-review",
      catalogGaps: [],
      files: [],
      manifest: {
        productionCompositions: [],
        screens: [{ entry: "page.tsx", route: "/" }],
      },
      routes: ["/"],
    };
    const rendererFile = uiPreviewRendererFiles(input).files.find(
      (file) => file.path === "render.mts",
    );
    if (!rendererFile) {
      throw new Error("Generated preview renderer is missing");
    }
    const renderer = rendererFile.content;
    expect(renderer).toContain(".process(themeCss, {");
    expect(renderer).toContain("map: { inline: true, annotation: true, sourcesContent: true }");
    expect(renderer).toContain('stylesheet.append({ name: "source"');
    expect(renderer).not.toContain('themeCss + "\\n@source "');
    expect(renderer).toContain("const themeStyle = css.css.replace");
    expect(renderer).toContain("const bundledStyle = bundledCss.join");
    expect(renderer).toContain("</style><style>' + bundledStyle");
  });
});

it("preserves workspace executable modes when the preview compiler needs dependencies", async () => {
  const input: UiPreviewInput = {
    appId: "missing-preview-dependency",
    catalogGaps: [],
    files: [{ content: "export default function Page() { return null; }", path: "src/page.tsx" }],
    manifest: {
      assumptions: [],
      decisions: [],
      fixtureFacts: [],
      implementationNotes: [],
      openQuestions: [],
      productionComponents: [],
      productionCompositions: [],
      productionIcons: [],
      screens: [{ entry: "src/page.tsx", id: "home", route: "/", title: "Home" }],
      version: 1,
    },
    routes: ["/"],
  };
  const success = { exitCode: 0, stderr: "", stdout: "" };
  const run = vi
    .fn()
    .mockResolvedValueOnce({ ...success, exitCode: 1, stderr: "Could not resolve package" })
    .mockResolvedValue(success);
  const html = "<html>Preview</html>";
  await expect(
    renderUiPreview(input, {
      run,
      readTextFile: vi.fn().mockResolvedValue(html),
      writeTextFile: vi.fn(() => Promise.resolve()),
    }),
  ).resolves.toBe(html);
  const command = {
    command: `bun ${uiPreviewRendererFiles(input).root}/render.mts`,
    workingDirectory: "/workspace/repository",
  };
  expect(run.mock.calls).toEqual([
    [command],
    [{ ...command, command: workspaceBinInstallCommand("/workspace/repository", false) }],
    [command],
  ]);
});
