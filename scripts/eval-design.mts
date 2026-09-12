import { parseArgs } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
    "preview-url": { type: "string" },
    "arrusted-root": { type: "string" },
    "brief-file": { type: "string" },
    case: { type: "string" },
    "list-cases": { type: "boolean" },
    "source-dir": { type: "string" },
    "output-dir": { type: "string" },
    scenario: { type: "string" },
    "fixture-interactions": { type: "boolean" },
    "measurements-only": { type: "boolean" },
    "additional-desktop-size": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "mise run eval:design -- --preview-url URL --arrusted-root PATH (--brief-file FILE | --case ID) [--source-dir PATH] [--scenario FILE --fixture-interactions] [--additional-desktop-size WIDTHxHEIGHT] [--measurements-only] [--output-dir PATH]\n\nmise run eval:design -- --list-cases",
  );
  process.exit(0);
}
async function sources(root: string, relative = ""): Promise<{ path: string; content: string }[]> {
  const files = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(relative, entry.name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    if (entry.isDirectory()) files.push(...(await sources(root, path)));
    else if (entry.isFile() && /\.(tsx?|css)$/u.test(path))
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      files.push({ path, content: await readFile(join(root, path), "utf-8") });
  }
  return files;
}
async function main() {
  if (values["list-cases"]) {
    for (const designCase of await listDesignCases())
      console.log(`${designCase.id}\t${designCase.status}\t${designCase.title}`);
    return;
  }
  if (values.case && values["brief-file"])
    throw new Error("Use either --case or --brief-file, not both");
  if (!values["preview-url"] || !values["arrusted-root"] || (!values["brief-file"] && !values.case))
    throw new Error("Required: --preview-url, --arrusted-root, and --brief-file or --case");
  const url = new URL(values["preview-url"]);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use a normal HTTP(S) preview URL without credentials");
  if (values.scenario && !values["fixture-interactions"])
    throw new Error(
      "Interaction steps require --fixture-interactions: use only previews with simulated effects",
    );
  const output = resolve(
    values["output-dir"] ??
      join(".artifacts/design-quality", new Date().toISOString().replaceAll(/[:.]/gu, "-")),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const selectedCase = values.case ? await readDesignCase(values.case) : undefined;
  const brief = selectedCase
    ? appendReviewQuestions(selectedCase.brief, selectedCase.reviewQuestions)
    : await readFile(values["brief-file"]!, "utf-8");
  const limitations: string[] = [];
  const referenceRoot = resolve(values["arrusted-root"]);
  const tokenCss = await readFile(
    join(resolve(values["arrusted-root"]), "packages/design-systems/core/tokens/theme.css"),
    "utf-8",
  ).catch(() => {
    limitations.push("Reference theme could not be read; token evidence is incomplete.");
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
  const sharedFiles = await sources(join(referenceRoot, "packages", "design-systems")).catch(
    () => undefined,
  );
  const generatedCssRules = collectCssRuleEvidence(sourceFiles);
  const sharedCssRules = sharedFiles ? collectCssRuleEvidence(sharedFiles) : [];
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
  // An explicit scenario is always user-bound. Case scenarios are an optional
  // fixture convenience and never run unless interactions were explicitly enabled.
  const scenarioPath =
    values.scenario ??
    (selectedCase && values["fixture-interactions"] ? selectedCase.scenariosPath : undefined);
  const scenarios = scenarioPath
    ? scenariosSchema.parse(
        JSON.parse(
          await readFile(scenarioPath, "utf-8").catch((error) => {
            if (!values.scenario && (error as NodeJS.ErrnoException).code === "ENOENT") return "[]";
            throw error;
          }),
        ),
      )
    : [];
  const additionalDesktopSize = values["additional-desktop-size"]
    ? parseAdditionalDesktopSize(values["additional-desktop-size"])
    : undefined;
  console.log("Capturing existing preview across desktop window sizes…");
  const captures = await capturePreview({
    url: url.href,
    output,
    tokens: parseTokens(tokenCss),
    scenarios,
    generatedSourcePaths: sourceFiles.map((f) => f.path),
    generatedClassSignatures: collectIntrinsicClassSignatures(sourceFiles),
    sharedClassSignatures: sharedFiles ? collectIntrinsicClassSignatures(sharedFiles) : undefined,
    generatedClassTokens: collectClassTokenEvidence(sourceFiles),
    sharedClassTokens: sharedFiles ? collectClassTokenEvidence(sharedFiles) : undefined,
    generatedCssRules,
    sharedCssRules,
    generatedCssSourceFiles: sourceFiles.filter((file) => /\.css$/iu.test(file.path)),
    sharedCssSourceFiles: sharedFiles?.filter((file) => /\.css$/iu.test(file.path)),
    additionalDesktopSize,
  });
  limitations.push(...("limitations" in source ? source.limitations : []));
  for (const capture of captures) limitations.push(...(capture.styles?.limitations ?? []));
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
    referenceCommit = execFileSync("git", ["-C", referenceRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* Diagnostic only. */
  }
  const catalog = await readFile(
    join(referenceRoot, "docs/app-builder-ui-catalog.json"),
    "utf-8",
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
    ...(selectedCase
      ? {
          case: {
            id: selectedCase.id,
            title: selectedCase.title,
            status: selectedCase.status,
            notes: selectedCase.notes,
            evidence: selectedCase.evidence,
            reviewQuestions: selectedCase.reviewQuestions,
            outcomes: selectedCase.outcomes,
          },
        }
      : {}),
    captures,
  };
  // Save useful results before any model call; a failed judge never discards them.
  await writeFile(join(output, "measurements.json"), JSON.stringify(measured, null, 2), {
    mode: 0o600,
  });
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
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(join(output, "index.html"), renderReport(report), {
    mode: 0o600,
  });
  console.log(`Design report: ${join(output, "index.html")}`);
  console.log(
    `AI review: ${judge.status}. Scores are advisory; no generation or publication was performed.`,
  );
}
// Keep the CLI's terminal error handler attached to the promise.
// oxlint-disable promise/prefer-await-to-callbacks
// oxlint-disable-next-line promise/prefer-await-to-callbacks
// Keep the CLI's terminal error handler attached to the promise.
// oxlint-disable-next-line promise/prefer-await-to-then
main().catch((error) => {
  // Do not print network errors that can contain secret preview query strings.
  console.error(
    `Design evaluation could not finish (${error instanceof Error ? error.name : "error"}). Check preview availability and supplied input files. No runtime state was changed.`,
  );
  process.exitCode = 1;
});
// oxlint-enable promise/prefer-await-to-callbacks
