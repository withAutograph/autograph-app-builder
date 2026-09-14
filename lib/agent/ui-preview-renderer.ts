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
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function uiPreviewRendererFiles(input: UiPreviewInput) {
  const root = `.builder-preview/${uiPreviewSourceDigest(input)}`;
  // These public compositions use Arrusted's AG Charts runtime. Match its
  // Storybook setup only when the submitted interface actually uses charts.
  const chartInitialization = input.manifest.productionCompositions.some(({ name }) =>
    chartCompositions.has(name),
  )
    ? `import { bootstrapAgCharts } from "@autograph/compositions";
bootstrapAgCharts({ allowMissingLicense: true });`
    : "";
  const imports = input.manifest.screens
    .map((screen, index) => `import Screen${index} from ${JSON.stringify(`./${screen.entry}`)};`)
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
const config = JSON.parse(await readFile(path.join(repository, "tsconfig.json"), "utf-8"));
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
const themeCss = await readFile(theme, "utf-8");
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
  const interactionChecks = input.manifest.interactionChecks ?? [];
  const browserCheck = `import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const html = await readFile(new URL("./index.html", import.meta.url), "utf-8");
const checks = ${JSON.stringify(interactionChecks)};
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const failures = [];
  page.on("console", message => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("pageerror", error => failures.push(error.message));
  await page.setContent(html, { waitUntil: "networkidle" });
  for (const check of checks) {
    await page.evaluate(route => { location.hash = route; }, check.route);
    await page.waitForTimeout(50);
    const control = page.getByRole("button", { exact: true, name: check.controlName });
    if (await page.getByText(check.expectedText, { exact: true }).isVisible().catch(() => false))
      throw new Error("Expected interaction outcome was already visible before the action: " + check.expectedText);
    if (!(await control.isVisible()) || !(await control.isEnabled()))
      throw new Error("Expected interactive control is unavailable: " + check.controlName);
    await control.click();
    await page.waitForTimeout(50);
    if (!(await page.getByText(check.expectedText, { exact: true }).isVisible()))
      throw new Error("Expected interaction outcome did not become visible: " + check.expectedText);
  }
  if (failures.length > 0) throw new Error("Rendered preview reported browser errors: " + failures.join("; "));
  process.stdout.write(JSON.stringify({ interactionChecks: checks.length, viewport: "1440x900" }) + "\\n");
} finally {
  await browser.close();
}`;
  return {
    files: [
      ...input.files,
      { content: entry, path: "entry.tsx" },
      { content: renderer, path: "render.mts" },
      { content: browserCheck, path: "browser-check.mjs" },
    ],
    root,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function renderUiPreview(
  input: UiPreviewInput,
  sandbox: SandboxSession,
): Promise<string> {
  const bundle = uiPreviewRendererFiles(input);
  for (const file of bundle.files)
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await sandbox.writeTextFile({
      content: file.content,
      path: `/workspace/repository/${bundle.root}/${file.path}`,
    });
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
    /could not resolve|cannot find (?:module|package)/iu.test(`${result.stderr}\n${result.stdout}`)
  ) {
    const installation = await sandbox.run({
      command: "bun install",
      workingDirectory: "/workspace/repository",
    });
    if (installation.exitCode !== 0)
      throw new Error(
        installation.stderr || installation.stdout || "Dependency installation failed.",
      );
    result = await compile();
  }
  if (result.exitCode !== 0)
    throw new Error(result.stderr || result.stdout || "The preview compiler failed.");
  const html = await sandbox.readTextFile({
    path: `/workspace/repository/${bundle.root}/index.html`,
  });
  if (html === null) throw new Error("The preview compiler did not produce a document.");
  if ((input.manifest.interactionChecks?.length ?? 0) > 0) {
    const installation = await sandbox.run({
      command: "bun node_modules/playwright/cli.js install --with-deps chromium",
      workingDirectory: "/workspace/repository",
    });
    if (installation.exitCode !== 0)
      throw new Error(installation.stderr || installation.stdout || "Browser installation failed.");
    const interaction = await sandbox.run({
      command: `bun ${bundle.root}/browser-check.mjs`,
      workingDirectory: "/workspace/repository",
    });
    if (interaction.exitCode !== 0)
      throw new Error(
        interaction.stderr || interaction.stdout || "Browser interaction verification failed.",
      );
  }
  return html;
}
