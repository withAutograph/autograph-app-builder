import { parseArgs } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { capturePreview, scenariosSchema } from "./design-quality/browser";
import { analyzeSource, parseTokens } from "./design-quality/source";
import { judgeDesign } from "./design-quality/judge";
import { renderReport } from "./design-quality/report";

const { values } = parseArgs({
  options: {
    "preview-url": { type: "string" },
    "arrusted-root": { type: "string" },
    "brief-file": { type: "string" },
    "source-dir": { type: "string" },
    "output-dir": { type: "string" },
    scenario: { type: "string" },
    "fixture-interactions": { type: "boolean" },
    "measurements-only": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "mise run eval:design -- --preview-url URL --arrusted-root PATH --brief-file FILE [--source-dir PATH] [--scenario FILE --fixture-interactions] [--measurements-only] [--output-dir PATH]",
  );
  process.exit(0);
}
async function sources(
  root: string,
  relative = "",
): Promise<Array<{ path: string; content: string }>> {
  const files = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(root, path)));
    else if (entry.isFile() && /\.(tsx?|css)$/.test(path))
      files.push({ path, content: await readFile(join(root, path), "utf8") });
  }
  return files;
}
async function main() {
  if (
    !values["preview-url"] ||
    !values["arrusted-root"] ||
    !values["brief-file"]
  )
    throw new Error("Required: --preview-url, --arrusted-root, --brief-file");
  const url = new URL(values["preview-url"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use a normal HTTP(S) preview URL without credentials");
  if (values.scenario && !values["fixture-interactions"])
    throw new Error(
      "Interaction steps require --fixture-interactions: use only previews with simulated effects",
    );
  const output = resolve(
    values["output-dir"] ??
      join(
        ".artifacts/design-quality",
        new Date().toISOString().replace(/[:.]/g, "-"),
      ),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const brief = await readFile(values["brief-file"], "utf8");
  const tokenCss = await readFile(
    join(
      resolve(values["arrusted-root"]),
      "packages/design-systems/core/tokens/theme.css",
    ),
    "utf8",
  );
  const source = values["source-dir"]
    ? {
        status: "available",
        ...analyzeSource({
          files: await sources(resolve(values["source-dir"])),
          tokenCss,
        }),
      }
    : {
        status: "unassessed",
        reason:
          "No generated preview source supplied. Computed style matches do not prove component or token provenance.",
      };
  const scenarios = values.scenario
    ? scenariosSchema.parse(JSON.parse(await readFile(values.scenario, "utf8")))
    : [];
  console.log(
    "Capturing existing preview at desktop, tablet and mobile sizes…",
  );
  const captures = await capturePreview({
    url: url.href,
    output,
    tokens: parseTokens(tokenCss),
    scenarios,
  });
  const measured = {
    createdAt: new Date().toISOString(),
    referenceTheme: "packages/design-systems/core/tokens/theme.css",
    source,
    captures,
  };
  // Save useful results before any model call; a failed judge never discards them.
  await writeFile(
    join(output, "measurements.json"),
    JSON.stringify(measured, null, 2),
    { mode: 0o600 },
  );
  console.log("Browser measurements captured. Preparing advisory review…");
  const judge = values["measurements-only"]
    ? { status: "not-run", reason: "Measurements-only requested" }
    : await judgeDesign({
        brief,
        evidence: captures.map((c) => ({
          name: c.name,
          state: c.state,
          measurements: c.measurements,
          interaction: c.interaction,
        })),
        images: captures.map(({ name, path, width, height }) => ({
          name,
          path,
          width,
          height,
        })),
      });
  const report = { ...measured, judge };
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  await writeFile(join(output, "index.html"), renderReport(report), {
    mode: 0o600,
  });
  console.log(`Design report: ${join(output, "index.html")}`);
  console.log(
    `AI review: ${judge.status}. Scores are advisory; no generation or publication was performed.`,
  );
}
main().catch((error) => {
  // Do not print network errors that can contain secret preview query strings.
  console.error(
    `Design evaluation could not finish (${error instanceof Error ? error.name : "error"}). Check preview availability and supplied input files. No runtime state was changed.`,
  );
  process.exitCode = 1;
});
