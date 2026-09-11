import type { SandboxSession } from "eve/sandbox";

import { uiPreviewSourceDigest } from "./ui-preview";
import type { UiPreviewInput } from "./ui-preview";

const chartCompositions = new Set([
  "AgChartsHost",
  "ChartComposition",
  "BreakdownChart",
  "CombinedBarLineChart",
  "DonutChart",
  "HeatmapChart",
  "RangeMarkerChart",
  "ScatterChart",
  "StackedTimelineChart",
  "WaterfallChart",
]);

/** Compile the submitted interface against the actual checkout, not substitutes. */
export function uiPreviewRendererFiles(input: UiPreviewInput) {
  const root = `.builder-preview/${uiPreviewSourceDigest(input)}`;
  // These public compositions use Arrusted's AG Charts runtime. Match its
  // Storybook setup only when the submitted interface actually uses charts.
  const chartInitialization = input.manifest.productionCompositions.some(
    ({ name }) => chartCompositions.has(name)
  )
    ? `import { bootstrapAgCharts } from "@autograph/compositions";
bootstrapAgCharts({ allowMissingLicense: true });`
    : "";
  const imports = input.manifest.screens
    .map(
      (screen, index) =>
        `import Screen${index} from ${JSON.stringify(`./${screen.entry}`)};`
    )
    .join("\n");
  const routes = input.manifest.screens
    .map((screen, index) => `${JSON.stringify(screen.route)}: Screen${index}`)
    .join(",");
  const entry = `${imports}
import React from "react";
import { createRoot } from "react-dom/client";
${chartInitialization}
const screens = {${routes}};
const root = createRoot(document.getElementById("root"));
function render() {
  const Screen = screens[location.hash.slice(1)] || screens[${JSON.stringify(input.routes[0])}];
  root.render(React.createElement(Screen));
}
addEventListener("hashchange", render);
render();`;
  const renderer = `import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const root = import.meta.dir;
const repository = process.cwd();
const config = JSON.parse(await readFile(path.join(repository, "tsconfig.json"), "utf8"));
const aliases = config.compilerOptions?.paths ?? {};
const result = await Bun.build({
  entrypoints: [path.join(root, "entry.tsx")],
  target: "browser", format: "iife", minify: true,
  tsconfig: path.join(repository, "tsconfig.json"),
  plugins: [{ name: "repository-public-aliases", setup(build) {
    build.onResolve({ filter: /^@autograph\\// }, args => {
      const target = aliases[args.path]?.[0];
      return target ? { path: path.resolve(repository, target) } : undefined;
    });
  } }],
});
if (!result.success) throw new Error(result.logs.map(String).join("\\n"));
const theme = path.join(repository, "packages/design-systems/core/tokens/theme.css");
const themeCss = await readFile(theme, "utf8");
const css = await postcss([
  {
    postcssPlugin: "preview-sources",
    Once(stylesheet) {
      stylesheet.append({ name: "source", params: JSON.stringify(root) });
      stylesheet.append({ name: "source", params: JSON.stringify(path.dirname(path.dirname(theme))) });
    },
  },
  tailwind({ base: root }),
]).process(themeCss, {
  from: theme,
  map: { inline: true, annotation: true, sourcesContent: true },
});
const js = await result.outputs.find(output => output.path.endsWith(".js")).text();
const bundledCss = await Promise.all(result.outputs.filter(output => output.path.endsWith(".css")).map(output => output.text()));
const themeStyle = css.css.replace(/<\\/style/gi, "<\\\\/style");
const bundledStyle = bundledCss.join("\\n").replace(/<\\/style/gi, "<\\\\/style");
const script = js.replace(/<\\/script/gi, "<\\\\/script");
await writeFile(path.join(root, "index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${input.appId}</title><style>' + themeStyle + '</style><style>' + bundledStyle + '</style></head><body><div id="root"></div><script>' + script + '</script></body></html>');`;
  return {
    files: [
      ...input.files,
      { path: "entry.tsx", content: entry },
      { path: "render.mts", content: renderer },
    ],
    root,
  };
}

export async function renderUiPreview(
  input: UiPreviewInput,
  sandbox: SandboxSession
): Promise<string> {
  const bundle = uiPreviewRendererFiles(input);
  for (const file of bundle.files) {
    await sandbox.writeTextFile({
      path: `/workspace/repository/${bundle.root}/${file.path}`,
      content: file.content,
    });
  }
  // The command contains only a fixed executable and a builder-generated hex
  // directory. Submitted source is file content, never shell interpolation.
  const compile = () =>
    sandbox.run({
      command: `bun ${bundle.root}/render.mts`,
      workingDirectory: "/workspace/repository",
    });
  let result = await compile();
  if (
    result.exitCode !== 0 &&
    /could not resolve|cannot find (?:module|package)/iu.test(
      `${result.stderr}\n${result.stdout}`
    )
  ) {
    const installation = await sandbox.run({
      command: "bun install",
      workingDirectory: "/workspace/repository",
    });
    if (installation.exitCode !== 0) {
      throw new Error(
        installation.stderr ||
          installation.stdout ||
          "Dependency installation failed."
      );
    }
    result = await compile();
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || result.stdout || "The preview compiler failed."
    );
  }
  const html = await sandbox.readTextFile({
    path: `/workspace/repository/${bundle.root}/index.html`,
  });
  if (html === null) {
    throw new Error("The preview compiler did not produce a document.");
  }
  return html;
}
