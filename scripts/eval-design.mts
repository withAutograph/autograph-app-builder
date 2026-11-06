import { parseArgs } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  capturePreview,
  parseAdditionalDesktopSize,
  scenariosSchema,
} from "./design-quality/browser";
import { analyzeSource, parseTokens } from "./design-quality/source";
import { judgeDesign } from "./design-quality/judge";
import { renderReport } from "./design-quality/report";
import { readReference } from "./design-quality/reference";
import { scoreAdherence } from "./design-quality/evidence";
import {
  collectClassTokenEvidence,
  collectIntrinsicClassSignatures,
} from "./design-quality/class-evidence";
import { collectCssRuleEvidence } from "./design-quality/css-evidence";
import { appendReviewQuestions, listDesignCases, readDesignCase } from "./design-quality/cases";
import { execFileSync } from "node:child_process";

const { values } = parseArgs({
  options: {
    "additional-desktop-size": { type: "string" },
    "arrusted-root": { type: "string" },
    "brief-file": { type: "string" },
    case: { type: "string" },
    "fixture-interactions": { type: "boolean" },
    help: { type: "boolean" },
    "list-cases": { type: "boolean" },
    "measurements-only": { type: "boolean" },
    "output-dir": { type: "string" },
    "preview-url": { type: "string" },
    scenario: { type: "string" },
    "source-dir": { type: "string" },
  },
});
if (values.help === true) {
  console.log(
    "mise run eval:design -- --preview-url URL --arrusted-root PATH (--brief-file FILE | --case ID) [--source-dir PATH] [--scenario FILE --fixture-interactions] [--additional-desktop-size WIDTHxHEIGHT] [--measurements-only] [--output-dir PATH]\n\nmise run eval:design -- --list-cases",
  );
  process.exit(0);
}
async function sources(root: string, relative = ""): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const fileGroups = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        return [];
      }
      const relativePath = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        return await sources(root, relativePath);
      }
      if (entry.isFile() && /\.(?<extension>tsx?|css)$/u.test(relativePath)) {
        return [
          {
            content: await readFile(path.join(root, relativePath), "utf-8"),
            path: relativePath,
          },
        ];
      }
      return [];
    }),
  );
  return fileGroups.flat();
}
const hasText = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0;
const readSourceFiles = async (root: string | undefined, limitations: string[]) => {
  if (!hasText(root)) {
    return [];
  }
  try {
    return await sources(path.resolve(root));
  } catch {
    limitations.push("Generated source could not be read.");
    return [];
  }
};
const resolveInputs = () => {
  const {
    case: caseId,
    "brief-file": briefFile,
    scenario,
    "preview-url": previewUrl,
    "arrusted-root": arrustedRoot,
  } = values;
  if (hasText(caseId) && hasText(briefFile)) {
    throw new Error("Use either --case or --brief-file, not both");
  }
  if (!hasText(previewUrl) || !hasText(arrustedRoot)) {
    throw new Error("Required: --preview-url, --arrusted-root, and --brief-file or --case");
  }
  if (!hasText(briefFile) && !hasText(caseId)) {
    throw new Error("Required: --preview-url, --arrusted-root, and --brief-file or --case");
  }
  const url = new URL(previewUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("Use a normal HTTP(S) preview URL without credentials");
  }
  if (hasText(scenario) && values["fixture-interactions"] !== true) {
    throw new Error(
      "Interaction steps require --fixture-interactions: use only previews with simulated effects",
    );
  }
  return { arrustedRoot, url };
};
const missingScenarioFallback = async (
  scenarioPath: string,
  explicitScenario: string | undefined,
) => {
  if (hasText(explicitScenario)) {
    throw new Error("Explicit scenario could not be read");
  }
  try {
    return await readFile(scenarioPath, "utf-8");
  } catch {
    return "[]";
  }
};
const loadScenarios = async (
  scenarioPath: string | undefined,
  explicitScenario: string | undefined,
) => {
  if (!hasText(scenarioPath)) {
    return [];
  }
  let content: string;
  try {
    content = await readFile(scenarioPath, "utf-8");
  } catch {
    const fallback = await missingScenarioFallback(scenarioPath, explicitScenario);
    return scenariosSchema.parse(JSON.parse(fallback));
  }
  return scenariosSchema.parse(JSON.parse(content));
};
const loadReferenceAssets = async (referenceRoot: string, limitations: string[]) => {
  let tokenCss = "";
  try {
    tokenCss = await readFile(
      path.join(referenceRoot, "packages/design-systems/core/tokens/theme.css"),
      "utf-8",
    );
  } catch {
    limitations.push("Reference theme could not be read; token evidence is incomplete.");
  }
  const reference = await readReference(referenceRoot);
  limitations.push(...reference.limitations);
  let sharedFiles: { path: string; content: string }[] | null = null;
  try {
    sharedFiles = await sources(path.join(referenceRoot, "packages", "design-systems"));
  } catch {
    sharedFiles = null;
  }
  return { reference, sharedFiles, tokenCss };
};
const readCatalog = async (referenceRoot: string): Promise<string> => {
  try {
    return await readFile(path.join(referenceRoot, "docs/app-builder-ui-catalog.json"), "utf-8");
  } catch {
    return "";
  }
};
const readReferenceCommit = (referenceRoot: string): string | null => {
  try {
    return execFileSync("/usr/bin/git", ["-C", referenceRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};
const makeSourceEvidence = (
  sourceDir: string | undefined,
  sourceFiles: { path: string; content: string }[],
  reference: Awaited<ReturnType<typeof readReference>>,
  tokenCss: string,
) => {
  if (!hasText(sourceDir)) {
    return {
      reason:
        "No generated preview source supplied. Computed style matches do not prove component or token provenance.",
      status: "unassessed",
    };
  }
  return { status: "available", ...analyzeSource({ files: sourceFiles, reference, tokenCss }) };
};
async function main() {
  if (values["list-cases"] === true) {
    for (const designCase of await listDesignCases()) {
      console.log(`${designCase.id}\t${designCase.status}\t${designCase.title}`);
    }
    return;
  }
  const { arrustedRoot, url } = resolveInputs();
  const output = path.resolve(
    values["output-dir"] ??
      path.join(".artifacts/design-quality", new Date().toISOString().replaceAll(/[:.]/gu, "-")),
  );
  await mkdir(output, { mode: 0o700, recursive: true });
  const selectedCase = hasText(values.case) ? await readDesignCase(values.case) : undefined;
  const brief =
    selectedCase === undefined
      ? await readFile(values["brief-file"] ?? "", "utf-8")
      : appendReviewQuestions(selectedCase.brief, selectedCase.reviewQuestions);
  const limitations: string[] = [];
  const referenceRoot = path.resolve(arrustedRoot);
  const { reference, sharedFiles, tokenCss } = await loadReferenceAssets(
    referenceRoot,
    limitations,
  );
  const sourceFiles = await readSourceFiles(values["source-dir"], limitations);
  // A read-only candidate inventory, not proof of rendered component identity.
  const generatedCssRules = collectCssRuleEvidence(sourceFiles);
  const sharedCssRules = sharedFiles === null ? [] : collectCssRuleEvidence(sharedFiles);
  const source = makeSourceEvidence(values["source-dir"], sourceFiles, reference, tokenCss);
  // An explicit scenario is always user-bound. Case scenarios are an optional
  // fixture convenience and never run unless interactions were explicitly enabled.
  const scenarioPath =
    values.scenario ??
    (selectedCase !== undefined && values["fixture-interactions"] === true
      ? selectedCase.scenariosPath
      : undefined);
  const scenarios = await loadScenarios(scenarioPath, values.scenario);
  const additionalDesktopSize = hasText(values["additional-desktop-size"])
    ? parseAdditionalDesktopSize(values["additional-desktop-size"])
    : undefined;
  console.log("Capturing existing preview across desktop window sizes…");
  const captures = await capturePreview({
    additionalDesktopSize,
    generatedClassSignatures: collectIntrinsicClassSignatures(sourceFiles),
    generatedClassTokens: collectClassTokenEvidence(sourceFiles),
    generatedCssRules,
    generatedCssSourceFiles: sourceFiles.filter((file) => /\.css$/iu.test(file.path)),
    generatedSourcePaths: sourceFiles.map((f) => f.path),
    output,
    scenarios,
    sharedClassSignatures:
      sharedFiles === null ? undefined : collectIntrinsicClassSignatures(sharedFiles),
    sharedClassTokens: sharedFiles === null ? undefined : collectClassTokenEvidence(sharedFiles),
    sharedCssRules,
    sharedCssSourceFiles: sharedFiles?.filter((file) => /\.css$/iu.test(file.path)),
    tokens: parseTokens(tokenCss),
    url: url.href,
  });
  limitations.push(...("limitations" in source ? source.limitations : []));
  for (const capture of captures) {
    limitations.push(...(capture.styles?.limitations ?? []));
  }
  const adherence = scoreAdherence(
    [
      ...("observations" in source ? source.observations : []),
      ...captures.flatMap((c) => c.styles?.observations ?? []),
    ],
    [...new Set(limitations)],
    sourceFiles.length > 0,
  );
  const referenceCommit = readReferenceCommit(referenceRoot);
  const catalog = await readCatalog(referenceRoot);
  const measured = {
    adherence,
    captures,
    createdAt: new Date().toISOString(),
    reference: {
      catalogAvailable: catalog.length > 0,
      commit: referenceCommit,
      name: referenceRoot.split("/").pop(),
      publicModules: Object.keys(reference.modules),
    },
    referenceTheme: "packages/design-systems/core/tokens/theme.css",
    source,
    sourceFiles,
  };
  const reportMeasurements: typeof measured & { case?: NonNullable<typeof selectedCase> } = {
    ...measured,
  };
  if (selectedCase !== undefined) {
    reportMeasurements.case = selectedCase;
  }
  // Save useful results before any model call; a failed judge never discards them.
  await writeFile(
    path.join(output, "measurements.json"),
    JSON.stringify(reportMeasurements, null, 2),
    {
      mode: 0o600,
    },
  );
  console.log("Browser measurements captured. Preparing advisory review…");
  const judge =
    values["measurements-only"] === true
      ? { reason: "Measurements-only requested", status: "not-run" }
      : await judgeDesign({
          brief,
          evidence: {
            adherence: {
              dimensions: adherence.dimensions,
              limitations: adherence.limitations,
            },
            arrustedCapabilities: catalog,
            captures: captures.map((c) => ({
              interaction: c.interaction,
              measurements: c.measurements,
              name: c.name,
              state: c.state,
            })),
            sourceFindings: adherence.observations.filter(
              (o) => o.evidence === "static" && o.verdict !== "conforming",
            ),
          },
          images: captures.map(({ name, path: screenshotPath, width, height }) => ({
            height,
            name,
            path: screenshotPath,
            width,
          })),
        });
  const report = { ...reportMeasurements, judge };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await writeFile(path.join(output, "index.html"), renderReport(report), {
    mode: 0o600,
  });
  console.log(`Design report: ${path.join(output, "index.html")}`);
  console.log(
    `AI review: ${judge.status}. Scores are advisory; no generation or publication was performed.`,
  );
}
try {
  await main();
} catch (error: unknown) {
  // Do not print network errors that can contain secret preview query strings.
  console.error(
    `Design evaluation could not finish (${error instanceof Error ? error.name : "error"}). Check preview availability and supplied input files. No runtime state was changed.`,
  );
  process.exitCode = 1;
}
