import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  capturePreview,
  parseAdditionalDesktopSize,
  scenariosSchema,
} from "./design-quality/browser";
import {
  appendReviewQuestions,
  listDesignCases,
  readDesignCase,
} from "./design-quality/cases";
import {
  collectClassTokenEvidence,
  collectIntrinsicClassSignatures,
} from "./design-quality/class-evidence";
import { collectCssRuleEvidence } from "./design-quality/css-evidence";
import { scoreAdherence } from "./design-quality/evidence";
import { judgeDesign } from "./design-quality/judge";
import { readReference } from "./design-quality/reference";
import { renderReport } from "./design-quality/report";
import { analyzeSource, parseTokens } from "./design-quality/source";

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
if (values.help) {
  console.log(
    "mise run eval:design -- --preview-url URL --arrusted-root PATH (--brief-file FILE | --case ID) [--source-dir PATH] [--scenario FILE --fixture-interactions] [--additional-desktop-size WIDTHxHEIGHT] [--measurements-only] [--output-dir PATH]\n\nmise run eval:design -- --list-cases"
  );
  process.exit(0);
}
async function sources(
  root: string,
  relative = ""
): Promise<{ path: string; content: string }[]> {
  const files = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const path = join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sources(root, path)));
    } else if (entry.isFile() && /\.(tsx?|css)$/.test(path)) {
      files.push({ path, content: await readFile(join(root, path), "utf8") });
    }
  }
  return files;
}
async function main() {
  if (values["list-cases"]) {
    for (const designCase of await listDesignCases()) {
      console.log(
        `${designCase.id}\t${designCase.status}\t${designCase.title}`
      );
    }
    return;
  }
  if (values.case && values["brief-file"]) {
    throw new Error("Use either --case or --brief-file, not both");
  }
  if (
    !values["preview-url"] ||
    !values["arrusted-root"] ||
    (!values["brief-file"] && !values.case)
  ) {
    throw new Error(
      "Required: --preview-url, --arrusted-root, and --brief-file or --case"
    );
  }
  const url = new URL(values["preview-url"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Use a normal HTTP(S) preview URL without credentials");
  }
  if (values.scenario && !values["fixture-interactions"]) {
    throw new Error(
      "Interaction steps require --fixture-interactions: use only previews with simulated effects"
    );
  }
  const output = resolve(
    values["output-dir"] ??
      join(
        ".artifacts/design-quality",
        new Date().toISOString().replaceAll(/[:.]/g, "-")
      )
  );
  await mkdir(output, { mode: 0o700, recursive: true });
  const selectedCase = values.case
    ? await readDesignCase(values.case)
    : undefined;
  const brief = selectedCase
    ? appendReviewQuestions(selectedCase.brief, selectedCase.reviewQuestions)
    : await readFile(values["brief-file"]!, "utf-8");
  const limitations: string[] = [];
  const referenceRoot = resolve(values["arrusted-root"]);
  const tokenCss = await readFile(
    join(
      resolve(values["arrusted-root"]),
      "packages/design-systems/core/tokens/theme.css"
    ),
    "utf-8"
  ).catch(() => {
    limitations.push(
      "Reference theme could not be read; token evidence is incomplete."
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
    join(referenceRoot, "packages", "design-systems")
  ).catch(() => {});
  const generatedCssRules = collectCssRuleEvidence(sourceFiles);
  const sharedCssRules = sharedFiles ? collectCssRuleEvidence(sharedFiles) : [];
  const source = values["source-dir"]
    ? {
        status: "available",
        ...analyzeSource({
          files: sourceFiles,
          reference,
          tokenCss,
        }),
      }
    : {
        reason:
          "No generated preview source supplied. Computed style matches do not prove component or token provenance.",
        status: "unassessed",
      };
  // An explicit scenario is always user-bound. Case scenarios are an optional
  // fixture convenience and never run unless interactions were explicitly enabled.
  const scenarioPath =
    values.scenario ??
    (selectedCase && values["fixture-interactions"]
      ? selectedCase.scenariosPath
      : undefined);
  const scenarios = scenarioPath
    ? scenariosSchema.parse(
        JSON.parse(
          await readFile(scenarioPath, "utf-8").catch((error) => {
            if (
              !values.scenario &&
              (error as NodeJS.ErrnoException).code === "ENOENT"
            ) {
              return "[]";
            }
            throw error;
          })
        )
      )
    : [];
  const additionalDesktopSize = values["additional-desktop-size"]
    ? parseAdditionalDesktopSize(values["additional-desktop-size"])
    : undefined;
  console.log("Capturing existing preview across desktop window sizes…");
  const captures = await capturePreview({
    additionalDesktopSize,
    generatedClassSignatures: collectIntrinsicClassSignatures(sourceFiles),
    generatedClassTokens: collectClassTokenEvidence(sourceFiles),
    generatedCssRules,
    generatedCssSourceFiles: sourceFiles.filter((file) =>
      /\.css$/i.test(file.path)
    ),
    generatedSourcePaths: sourceFiles.map((f) => f.path),
    output,
    scenarios,
    sharedClassSignatures: sharedFiles
      ? collectIntrinsicClassSignatures(sharedFiles)
      : undefined,
    sharedClassTokens: sharedFiles
      ? collectClassTokenEvidence(sharedFiles)
      : undefined,
    sharedCssRules,
    sharedCssSourceFiles: sharedFiles?.filter((file) =>
      /\.css$/i.test(file.path)
    ),
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
    sourceFiles.length > 0
  );
  let referenceCommit: string | null = null;
  try {
    referenceCommit = execFileSync(
      "git",
      ["-C", referenceRoot, "rev-parse", "HEAD"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    /* Diagnostic only. */
  }
  const catalog = await readFile(
    join(referenceRoot, "docs/app-builder-ui-catalog.json"),
    "utf-8"
  ).catch(() => "");
  const measured = {
    createdAt: new Date().toISOString(),
    referenceTheme: "packages/design-systems/core/tokens/theme.css",
    source,
    sourceFiles,
    adherence,
    reference: {
      catalogAvailable: !!catalog,
      commit: referenceCommit,
      name: referenceRoot.split("/").pop(),
      publicModules: Object.keys(reference.modules),
    },
    ...(selectedCase
      ? {
          case: {
            evidence: selectedCase.evidence,
            id: selectedCase.id,
            notes: selectedCase.notes,
            outcomes: selectedCase.outcomes,
            reviewQuestions: selectedCase.reviewQuestions,
            status: selectedCase.status,
            title: selectedCase.title,
          },
        }
      : {}),
    captures,
  };
  // Save useful results before any model call; a failed judge never discards them.
  await writeFile(
    join(output, "measurements.json"),
    JSON.stringify(measured, null, 2),
    { mode: 0o600 }
  );
  console.log("Browser measurements captured. Preparing advisory review…");
  const judge = values["measurements-only"]
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
            name: c.name,
            state: c.state,
            measurements: c.measurements,
            interaction: c.interaction,
          })),
          sourceFindings: adherence.observations.filter(
            (o) => o.evidence === "static" && o.verdict !== "conforming"
          ),
        },
        images: captures.map(({ name, path, width, height }) => ({
          height,
          name,
          path,
          width,
        })),
      });
  const report = { ...measured, judge };
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 }
  );
  await writeFile(join(output, "index.html"), renderReport(report), {
    mode: 0o600,
  });
  console.log(`Design report: ${join(output, "index.html")}`);
  console.log(
    `AI review: ${judge.status}. Scores are advisory; no generation or publication was performed.`
  );
}
main().catch((error) => {
  // Do not print network errors that can contain secret preview query strings.
  console.error(
    `Design evaluation could not finish (${error instanceof Error ? error.name : "error"}). Check preview availability and supplied input files. No runtime state was changed.`
  );
  process.exitCode = 1;
});
