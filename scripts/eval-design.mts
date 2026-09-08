import { parseArgs } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { capturePreview, scenariosSchema } from "./design-quality/browser";
import { analyzeSource, parseTokens } from "./design-quality/source";
import { judgeDesign } from "./design-quality/judge";
import { renderReport } from "./design-quality/report";
import { readReference } from "./design-quality/reference";
import { scoreAdherence } from "./design-quality/evidence";
import { collectIntrinsicClassSignatures } from "./design-quality/class-evidence";
import { execFileSync } from "node:child_process";

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
  const limitations: string[] = [];
  const referenceRoot = resolve(values["arrusted-root"]);
  const tokenCss = await readFile(
    join(
      resolve(values["arrusted-root"]),
      "packages/design-systems/core/tokens/theme.css",
    ),
    "utf8",
  ).catch(() => {
    limitations.push(
      "Reference theme could not be read; token evidence is incomplete.",
    );
    return "";
  });
  const reference = await readReference(referenceRoot);
  limitations.push(...reference.limitations);
  const sourceFiles = values["source-dir"]
    ? await sources(resolve(values["source-dir"])).catch(() => {
        limitations.push("Generated source could not be read.");
        return [];
      })
    : [];
  // A read-only candidate inventory, not proof of rendered component identity.
  const sharedFiles = await sources(
    join(referenceRoot, "packages", "design-systems"),
  ).catch(() => undefined);
  const source = values["source-dir"]
    ? {
        status: "available",
        ...analyzeSource({
          files: sourceFiles,
          tokenCss,
          reference,
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
  console.log("Capturing existing preview across desktop window sizes…");
  const captures = await capturePreview({
    url: url.href,
    output,
    tokens: parseTokens(tokenCss),
    scenarios,
    generatedSourcePaths: sourceFiles.map((f) => f.path),
    generatedClassSignatures: collectIntrinsicClassSignatures(sourceFiles),
    sharedClassSignatures: sharedFiles
      ? collectIntrinsicClassSignatures(sharedFiles)
      : undefined,
  });
  limitations.push(...("limitations" in source ? source.limitations : []));
  for (const capture of captures)
    limitations.push(...(capture.styles?.limitations ?? []));
  const adherence = scoreAdherence(
    [
      ...("observations" in source ? source.observations : []),
      ...captures.flatMap((c) => c.styles?.observations ?? []),
    ],
    [...new Set(limitations)],
    sourceFiles.length > 0,
  );
  let referenceCommit: string | null = null;
  try {
    referenceCommit = execFileSync(
      "git",
      ["-C", referenceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    /* Diagnostic only. */
  }
  const catalog = await readFile(
    join(referenceRoot, "docs/app-builder-ui-catalog.json"),
    "utf8",
  ).catch(() => "");
  const measured = {
    createdAt: new Date().toISOString(),
    referenceTheme: "packages/design-systems/core/tokens/theme.css",
    source,
    sourceFiles,
    adherence,
    reference: {
      name: referenceRoot.split("/").pop(),
      commit: referenceCommit,
      publicModules: Object.keys(reference.modules),
      catalogAvailable: !!catalog,
    },
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
        evidence: {
          arrustedCapabilities: catalog,
          adherence: {
            dimensions: adherence.dimensions,
            limitations: adherence.limitations,
          },
          sourceFindings: adherence.observations.filter(
            (o) => o.evidence === "static" && o.verdict !== "conforming",
          ),
          captures: captures.map((c) => ({
            name: c.name,
            state: c.state,
            measurements: c.measurements,
            interaction: c.interaction,
          })),
        },
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
