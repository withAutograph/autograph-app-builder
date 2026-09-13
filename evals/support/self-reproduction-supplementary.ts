/* oxlint-disable eslint/no-await-in-loop -- preserve ordered evidence copies and deterministic merges. */
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assessParity,
  observationSchema,
  parityEvidenceSchema,
  sides,
} from "./self-reproduction-parity";
import type { Observation } from "./self-reproduction-parity";

/** Source assertions can supplement behavior, but never erase a failure or supply behavioral method credit. */
export function mergeSupplementaryObservation(
  runtime: Observation | undefined,
  review: Observation,
): Observation {
  if (!runtime) return review;
  const assertions = new Map(runtime.assertions.map((item) => [item.id, item]));
  for (const item of review.assertions) {
    const prior = assertions.get(item.id);
    assertions.set(
      item.id,
      prior
        ? {
            ...prior,
            passed: prior.passed && item.passed,
            detail: `${prior.detail} Source review: ${item.detail}`,
            artifacts: [...new Set([...prior.artifacts, ...item.artifacts])],
          }
        : item,
    );
  }
  const failed =
    runtime.disposition === "missing-functionality" ||
    review.disposition === "missing-functionality";
  const behavioral =
    ["browser", "source-and-browser", "@next/playwright/instant"].includes(runtime.method) &&
    runtime.disposition === "observed";
  return {
    requirementId: runtime.requirementId,
    disposition: failed ? "missing-functionality" : runtime.disposition,
    reason: `${runtime.reason} Supplementary source review: ${review.reason}`,
    assertions: [...assertions.values()],
    artifacts: [...new Set([...runtime.artifacts, ...review.artifacts])],
    method:
      behavioral && runtime.method !== "@next/playwright/instant"
        ? "source-and-browser"
        : runtime.method,
  };
}

function safeRelative(path: string) {
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/u).some((part) => !part || part === ".." || part.startsWith(".env")) ||
    /(?:^|\/)(?:node_modules|runtime-source|reference-runtime)(?:\/|$)/u.test(path)
  )
    throw new Error(`Unsupported evidence artifact path: ${path}`);
  return path;
}

export async function writeSupplementaryAssessment(input: {
  runDirectory: string;
  sourceReviewDirectory: string;
  outputDirectory: string;
  referenceCapturesDirectory?: string;
}) {
  const output = resolve(input.outputDirectory);
  const roots = await Promise.all(
    [input.runDirectory, input.sourceReviewDirectory].map((path) => realpath(path)),
  );
  for (const root of roots)
    if (output === root || output.startsWith(`${root}${sep}`))
      throw new Error("Supplementary output must be separate from the original evidence.");
  await mkdir(output, { recursive: false });
  const missing: string[] = [];
  const copied = new Set<string>();
  const copy = async (root: string, artifact: string, prefix: string) => {
    safeRelative(artifact);
    const target = `${prefix}/${artifact}`;
    if (copied.has(target)) return target;
    try {
      const source = await realpath(join(root, artifact));
      if (relative(root, source).startsWith("..") || !(await stat(source)).isFile())
        throw new Error("Artifact is not a contained regular file.");
      await mkdir(dirname(join(output, target)), { recursive: true });
      await copyFile(source, join(output, target));
      copied.add(target);
    } catch (error) {
      missing.push(`${target}: ${String(error)}`);
    }
    return target;
  };
  const evidence = parityEvidenceSchema.parse(
    JSON.parse(await readFile(join(roots[0]!, "parity-evidence.json"), "utf-8")),
  );
  const review = JSON.parse(await readFile(join(roots[1]!, "observations.json"), "utf-8")) as {
    schemaVersion?: string;
    observations?: Record<string, unknown[]>;
  };
  if (review.schemaVersion !== "self-reproduction-source-review/v1")
    throw new Error("Expected evaluator-owned source review schema.");
  try {
    const workflowReview = JSON.parse(
      await readFile(join(roots[1]!, "workflow-observations.json"), "utf-8"),
    ) as typeof review;
    if (workflowReview.schemaVersion !== "self-reproduction-source-review/v1")
      throw new Error("Expected evaluator-owned workflow source review schema.");
    for (const side of sides) {
      review.observations ??= {};
      review.observations[side] = [
        ...(review.observations[side] ?? []),
        ...(workflowReview.observations?.[side] ?? []),
      ];
    }
    await copy(roots[1]!, "workflow-observations.json", "source-review");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Retain the original metadata and source review unchanged as provenance snapshots.
  for (const path of ["report.json", "parity-evidence.json", "revisions.json"])
    await copy(roots[0]!, path, "original");
  for (const path of ["observations.json", "source-evidence.json", "report.md"])
    await copy(roots[1]!, path, "source-review");
  const originalReport = JSON.parse(await readFile(join(roots[0]!, "report.json"), "utf-8"));
  for (const capture of originalReport.captures ?? [])
    for (const path of capture.files ?? [])
      if (typeof path === "string") await copy(roots[0]!, path, "original");
  const rebase = async (
    value: Observation,
    root: string,
    prefix: string,
  ): Promise<Observation> => ({
    ...value,
    artifacts: await Promise.all(value.artifacts.map((path) => copy(root, path, prefix))),
    assertions: await Promise.all(
      value.assertions.map(async (assertion) => ({
        ...assertion,
        artifacts: await Promise.all(assertion.artifacts.map((path) => copy(root, path, prefix))),
      })),
    ),
  });
  for (const side of sides) {
    evidence[side].observations = await Promise.all(
      evidence[side].observations.map((item) => rebase(item, roots[0]!, "original")),
    );
    for (const raw of review.observations?.[side] ?? []) {
      const item = raw as Observation;
      const normalized = observationSchema.parse({
        ...item,
        method: "source-review",
        assertions: item.assertions.map((assertion) => ({
          ...assertion,
          artifacts: assertion.artifacts ?? ["source-evidence.json"],
        })),
      });
      const source = await rebase(normalized, roots[1]!, "source-review");
      const index = evidence[side].observations.findIndex(
        (entry) => entry.requirementId === source.requirementId,
      );
      const merged = mergeSupplementaryObservation(evidence[side].observations[index], source);
      if (index === -1) evidence[side].observations.push(merged);
      else evidence[side].observations[index] = merged;
    }
  }
  const screenshotPairs: {
    viewport: string;
    reference: string;
    candidate: string;
    qualification: string;
  }[] = [];
  if (input.referenceCapturesDirectory) {
    const captureRoot = await realpath(input.referenceCapturesDirectory);
    await copy(captureRoot, "capture-provenance.json", "reference-captures");
    const captureMetadata = JSON.parse(
      await readFile(join(captureRoot, "capture-provenance.json"), "utf-8"),
    );
    for (const capture of captureMetadata.captures ?? []) {
      const artifact = safeRelative(relative(captureRoot, capture.path));
      const reference = await copy(captureRoot, artifact, "reference-captures");
      const viewport = String(capture.name).replace(/-0$/u, "");
      const candidate = `original/candidate-browser/${viewport}/root.png`;
      if (copied.has(candidate) && copied.has(reference))
        screenshotPairs.push({
          viewport,
          reference,
          candidate,
          qualification:
            typeof captureMetadata.comparisonQualification === "string"
              ? captureMetadata.comparisonQualification
              : "Anonymous reference entry versus candidate default screen; these are not equivalent authenticated or workflow states.",
        });
    }
  }
  const assessment = await assessParity(evidence, (path) => Promise.resolve(copied.has(path)));
  // Source failures still need their retained source evidence to count as assessed.
  for (const row of assessment.rows)
    if (row.artifacts.some((path) => !copied.has(path))) {
      row.status = "unassessed";
      row.reasonCode = "evidence-incomplete";
      row.reason = "Referenced evidence was unavailable in the supplementary bundle.";
    }
  const report = {
    kind: "supplementary-assessment",
    originalRunId: evidence.runId,
    generatedAt: new Date().toISOString(),
    generationRerun: false,
    anonymousEntryPriority: "excluded",
    missingEvidence: missing,
    screenshotPairs,
    assessment,
  };
  await writeFile(join(output, "parity-evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  const rows = assessment.rows.map(
    (row) =>
      `| ${row.side} | ${row.requirementId} | ${row.status} | ${row.reason.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
  );
  const md = `# Supplementary self-reproduction assessment\n\nOriginal run: ${evidence.runId}. No generation or runtime rerun. Source review supplements retained behavioral evidence. Anonymous entry remains excluded from cleanup priority.\n\n| Side | Requirement | Status | Evidence finding |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Diagnostic initial screenshots\n\n${screenshotPairs.map((pair) => `- ${pair.viewport}: [reference](${pair.reference}), [candidate](${pair.candidate}). ${pair.qualification}`).join("\n")}\n`;
  await writeFile(join(output, "report.md"), md);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- report-only HTML helper.
  const escape = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const images = [...copied].filter((path) => path.endsWith(".png"));
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Supplementary self-reproduction assessment</title><style>body{font:15px system-ui;margin:2rem}pre{white-space:pre-wrap}img{max-width:48%;vertical-align:top}</style><pre>${escape(md)}</pre><h2>Diagnostic initial pairs</h2>${screenshotPairs.map((pair) => `<section><h3>${escape(pair.viewport)}</h3><p>${escape(pair.qualification)}</p><img src="${escape(pair.reference)}" alt="Reference initial screen"><img src="${escape(pair.candidate)}" alt="Candidate default screen"></section>`).join("")}<h2>Other retained screenshots</h2>${images.map((path) => `<a href="${escape(path)}"><img src="${escape(path)}" alt="${escape(path)}"></a>`).join("")}`,
  );
  return report;
}
