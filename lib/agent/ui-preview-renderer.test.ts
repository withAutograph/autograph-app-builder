import { runInNewContext } from "node:vm";
import postcss from "postcss";
import { describe, expect, it, vi } from "vitest";

import type { UiPreviewInput } from "./ui-preview";
import { renderUiPreview, uiPreviewRendererFiles } from "./ui-preview-renderer";

const previewInput = {
  appId: "browser-review",
  catalogGaps: [],
  files: [{ content: "export default () => null", path: "page.tsx" }],
  manifest: {
    productionCompositions: [],
    screens: [{ entry: "page.tsx", route: "/" }],
  },
  routes: ["/"],
} as unknown as UiPreviewInput;

const interactivePreviewInput = {
  ...previewInput,
  manifest: {
    ...previewInput.manifest,
    interactionChecks: [
      { controlName: "Show details", expectedText: "Visible detail", route: "/" },
    ],
  },
} as UiPreviewInput;

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
    } as unknown as UiPreviewInput;
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
      /sourceMappingURL=data:application\/json[^,]*,(?<sourceMap>[^*]+?)\s*\*\//u,
    )?.[1];
    expect(sourceMap).toBeDefined();
    if (!sourceMap) {
      throw new Error("Inline source map is missing");
    }
    const map = JSON.parse(Buffer.from(sourceMap, "base64").toString("utf-8")) as {
      sourcesContent?: (string | null)[];
    };
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
    } as unknown as UiPreviewInput;
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

describe("real sandbox browser verification", () => {
  it("installs the fixed browser and requires an interaction after compilation", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: '{"interacted":true,"viewport":"1440x900"}',
      });
    const sandbox = {
      readTextFile: vi.fn().mockResolvedValue("<html>preview</html>"),
      run,
      writeTextFile: vi.fn().mockResolvedValue(null),
    } as never;

    await expect(renderUiPreview(interactivePreviewInput, sandbox)).resolves.toBe(
      "<html>preview</html>",
    );
    expect(run).toHaveBeenNthCalledWith(2, {
      command: "bun node_modules/playwright/cli.js install --with-deps chromium",
      workingDirectory: "/workspace/repository",
    });
    expect(run).toHaveBeenNthCalledWith(3, {
      command: expect.stringMatching(/^bun \.builder-preview\/[a-f\d]+\/browser-check\.mjs$/u),
      workingDirectory: "/workspace/repository",
    });
  });

  it("rejects a preview whose real browser interaction fails", async () => {
    const sandbox = {
      readTextFile: vi.fn().mockResolvedValue("<html>preview</html>"),
      run: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
        .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
        .mockResolvedValueOnce({
          exitCode: 1,
          stderr: "Expected interaction outcome did not become visible: Visible detail",
          stdout: "",
        }),
      writeTextFile: vi.fn().mockResolvedValue(null),
    } as never;

    await expect(renderUiPreview(interactivePreviewInput, sandbox)).rejects.toThrow(
      "Expected interaction outcome did not become visible: Visible detail",
    );
  });

  it("does not install or run a browser when the preview declares no interaction checks", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const sandbox = {
      readTextFile: vi.fn().mockResolvedValue("<html>preview</html>"),
      run,
      writeTextFile: vi.fn().mockResolvedValue(null),
    } as never;

    await expect(renderUiPreview(previewInput, sandbox)).resolves.toBe("<html>preview</html>");
    expect(run).toHaveBeenCalledOnce();
  });
});
