/* oxlint-disable eslint/no-await-in-loop -- preserve ordered evidence copies and deterministic merges. */
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { z } from "zod";
import {
  assessParity,
  observationSchema,
  parityEvidenceSchema,
  sides,
} from "./self-reproduction-parity";
import type { Observation } from "./self-reproduction-parity";

const reviewObservationSchema = observationSchema.extend({
  assertions: z.array(
    observationSchema.shape.assertions.element.extend({
      artifacts: z.array(z.string()).optional(),
    }),
  ),
});
const sourceReviewSchema = z.object({
  observations: z.record(z.string(), z.array(reviewObservationSchema)).optional(),
  schemaVersion: z.string().optional(),
});
const captureMetadataSchema = z.object({
  captures: z.array(z.looseObject({ files: z.array(z.string()).optional() })).optional(),
  comparisonQualification: z.string().optional(),
});
const SOURCE_REVIEW_VERSION = "self-reproduction-source-review/v1";
const OBSERVATIONS_FILE = "observations.json";
const SOURCE_REVIEW_MARKER = "source-evidence.json";
const REPORT_FILE = "report.json";
const PARITY_EVIDENCE_FILE = "parity-evidence.json";
const REVISIONS_FILE = "revisions.json";
const REPORT_MARKDOWN_FILE = "report.md";
const SOURCE_AND_BROWSER_METHOD = "source-and-browser";
const MISSING_FUNCTIONALITY = "missing-functionality";
const PRESERVED_REPORT_FILES: string[] = [REPORT_FILE, REVISIONS_FILE];
const SOURCE_SNAPSHOT_FILES: string[] = [OBSERVATIONS_FILE, SOURCE_REVIEW_MARKER];
const REFERENCE_QUALIFICATION =
  "Anonymous reference entry versus candidate default screen; these are not equivalent authenticated or workflow states.";
const MISSING_CAPTURE_MESSAGE = "No paired captures retained.";
const ARTIFACT_PATH_MESSAGE = "Unsupported evidence artifact path: ";
const WORKFLOW_REVIEW_FILE = "workflow-observations.json";
const ORIGINAL_PREFIX = "original";
const SOURCE_PREFIX = "source-review";
const jsonSchema = z.record(z.string(), z.unknown());
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

const renderHtmlReport = (args: {
  runId: string;
  rows: Awaited<ReturnType<typeof assessParity>>["rows"];
  screenshotPairs: {
    viewport: string;
    reference: string;
    candidate: string;
    qualification: string;
  }[];
  images: string[];
  hasReferenceCaptures: boolean;
}) => {
  const statusNames = ["passed", "failed", "blocked", "unassessed"];
  const counts = sides
    .map((side) => {
      const sideRows = args.rows.filter((row) => row.side === side);
      const cells = statusNames
        .map((status) => {
          const count = sideRows.filter((row) => row.status === status).length;
          return `<td>${count}</td>`;
        })
        .join("");
      return `<tr><th>${side}</th>${cells}</tr>`;
    })
    .join("");
  const priorities = args.rows.filter(
    (row) =>
      row.side === "candidate" &&
      row.status === "failed" &&
      row.requirementId !== "anonymous-entry",
  );
  const pairMarkup = args.screenshotPairs
    .map((pair) => {
      const viewport = escapeHtml(pair.viewport);
      const qualification = escapeHtml(pair.qualification);
      const reference = escapeHtml(pair.reference);
      const candidate = escapeHtml(pair.candidate);
      return `<section><h3>${viewport}</h3><p class="qualification">${qualification}</p><div class="pair"><figure><figcaption>Handwritten reference</figcaption><a href="${reference}"><img src="${reference}" alt="Reference initial screen"></a></figure><figure><figcaption>Generated candidate</figcaption><a href="${candidate}"><img src="${candidate}" alt="Candidate default screen"></a></figure></div></section>`;
    })
    .join("");
  const findings = args.rows
    .map((row) => {
      const artifacts = row.artifacts
        .map((path, index) => {
          const safePath = escapeHtml(path);
          return `<a href="${safePath}">Evidence ${index + 1}</a>`;
        })
        .join("<br>");
      return `<tr><td>${escapeHtml(row.side)}</td><th>${escapeHtml(row.requirementId)}</th><td class="${row.status}">${row.status}</td><td>${escapeHtml(row.reason)}</td><td>${artifacts}</td></tr>`;
    })
    .join("");
  const priorityMarkup = priorities
    .map(
      (row) =>
        `<li><strong>${escapeHtml(row.requirementId)}</strong> — ${escapeHtml(row.reason)}</li>`,
    )
    .join("");
  const imageMarkup = args.images
    .map((path) => {
      const safePath = escapeHtml(path);
      return `<li><a href="${safePath}">${safePath}</a></li>`;
    })
    .join("");
  const captureLink = args.hasReferenceCaptures
    ? '<a href="reference-captures/capture-provenance.json">Capture provenance</a>'
    : "";
  const htmlHead = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Supplementary self-reproduction assessment</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:32px auto;padding:0 24px;max-width:1500px;color:#202124;background:#fafafa}h1{font-size:28px;margin-bottom:8px}h2{margin-top:32px}a{color:#1555a3}table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #ddd;vertical-align:top}thead{background:#eee}.summary{max-width:650px}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;background:white;border:1px solid #ddd}figcaption{padding:10px;font-weight:600}img{display:block;width:100%;height:auto}.qualification{color:#555}.failed{color:#a12622;font-weight:600}.passed{color:#256029}.findings{overflow-x:auto}.provenance{display:flex;flex-wrap:wrap;gap:16px}.note{max-width:1000px}li{margin:6px 0}
</style></head>`;
  const htmlBody = `<body><h1>How close did the generated app get?</h1><p class="note">Supplementary assessment of <strong>${escapeHtml(args.runId)}</strong>. Existing runtime evidence plus evaluator source review; no generation or runtime rerun. Counts describe requirement evidence, not a numerical similarity score. Anonymous entry is excluded from cleanup priority.</p><table class="summary"><thead><tr><th>Application</th><th>Passed</th><th>Failed</th><th>Blocked</th><th>Unassessed</th></tr></thead><tbody>${counts}</tbody></table><p class="provenance"><a href="original/${REPORT_FILE}">Original runtime report</a><a href="original/${REVISIONS_FILE}">Original revisions</a><a href="source-review/${SOURCE_REVIEW_MARKER}">Source review provenance</a>${captureLink}<a href="${REPORT_FILE}">Assessment JSON</a><a href="${REPORT_MARKDOWN_FILE}">Markdown report</a></p><h2>Initial screen comparison</h2>${pairMarkup || MISSING_CAPTURE_MESSAGE}<h2>Confirmed candidate gaps</h2><p>Workflow failures appear before framework and capture findings. These are separate requirements, not necessarily independent root causes.</p><ul>${priorityMarkup}</ul><h2>All requirement outcomes</h2><div class="findings"><table><thead><tr><th>Side</th><th>Requirement</th><th>Status</th><th>Finding</th><th>Artifacts</th></tr></thead><tbody>${findings}</tbody></table></div><details><summary>Other retained screenshots (${args.images.length})</summary><ul>${imageMarkup}</ul></details></body></html>`;
  return htmlHead + htmlBody;
};

const readJson = async (path: string) =>
  jsonSchema.parse(JSON.parse(await readFile(path, "utf-8")));

const screenshotPairSchema = z.object({
  captures: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        path: z.string(),
        viewport: z.object({ name: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  comparisonQualification: z.string().optional(),
});

const safeRelative = (pathValue: string) => {
  if (
    nodePath.isAbsolute(pathValue) ||
    pathValue.split(/[\\/]/u).some((part) => !part || part === ".." || part.startsWith(".env")) ||
    /(?:^|\/)(?:node_modules|runtime-source|reference-runtime)(?:\/|$)/u.test(pathValue)
  ) {
    throw new Error(`${ARTIFACT_PATH_MESSAGE}${pathValue}`);
  }
  return pathValue;
};

const mergeWorkflowReview = async (
  review: z.infer<typeof sourceReviewSchema>,
  reviewRoot: string,
  copy: (root: string, artifact: string, prefix: string) => Promise<string>,
) => {
  try {
    const workflowReview = sourceReviewSchema.parse(
      JSON.parse(await readFile(nodePath.join(reviewRoot, WORKFLOW_REVIEW_FILE), "utf-8")),
    );
    if (workflowReview.schemaVersion !== SOURCE_REVIEW_VERSION) {
      throw new Error("Expected evaluator-owned workflow source review schema.");
    }
    for (const side of sides) {
      review.observations ??= {};
      review.observations[side] = [
        ...(review.observations[side] ?? []),
        ...(workflowReview.observations?.[side] ?? []),
      ];
    }
    await copy(reviewRoot, WORKFLOW_REVIEW_FILE, SOURCE_PREFIX);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
};

/** Source assertions can supplement behavior, but never erase a failure or supply behavioral method credit. */
export const mergeSupplementaryObservation = (
  runtime: Observation | undefined,
  review: Observation,
): Observation => {
  if (!runtime) {
    return review;
  }
  const assertions = new Map(runtime.assertions.map((item) => [item.id, item]));
  for (const item of review.assertions) {
    const prior = assertions.get(item.id);
    assertions.set(
      item.id,
      prior
        ? {
            ...prior,
            artifacts: [...new Set([...prior.artifacts, ...item.artifacts])],
            detail: `${prior.detail} Source review: ${item.detail}`,
            passed: prior.passed && item.passed,
          }
        : item,
    );
  }
  const failed =
    runtime.disposition === MISSING_FUNCTIONALITY || review.disposition === MISSING_FUNCTIONALITY;
  const behavioral =
    ["browser", SOURCE_AND_BROWSER_METHOD, "@next/playwright/instant"].includes(runtime.method) &&
    runtime.disposition === "observed";
  return {
    artifacts: [...new Set([...runtime.artifacts, ...review.artifacts])],
    assertions: [...assertions.values()],
    disposition: failed ? MISSING_FUNCTIONALITY : runtime.disposition,
    method:
      behavioral && runtime.method !== "@next/playwright/instant"
        ? SOURCE_AND_BROWSER_METHOD
        : runtime.method,
    reason: `${runtime.reason} Supplementary source review: ${review.reason}`,
    requirementId: runtime.requirementId,
  };
};

const rebaseObservations = async (
  evidence: z.infer<typeof parityEvidenceSchema>,
  review: z.infer<typeof sourceReviewSchema>,
  parityRoot: string,
  reviewRoot: string,
  rebase: (value: Observation, root: string, prefix: string) => Promise<Observation>,
) => {
  for (const side of sides) {
    evidence[side].observations = await Promise.all(
      evidence[side].observations.map(
        async (item) => await rebase(item, parityRoot, ORIGINAL_PREFIX),
      ),
    );
    const rebasedSources = await Promise.all(
      (review.observations?.[side] ?? []).map(
        async (item) =>
          await rebase(
            observationSchema.parse({
              ...item,
              assertions: item.assertions.map((assertion) => ({
                ...assertion,
                artifacts: assertion.artifacts ?? ["source-evidence.json"],
              })),
              method: "source-review",
            }),
            reviewRoot,
            SOURCE_PREFIX,
          ),
      ),
    );
    for (const source of rebasedSources) {
      const index = evidence[side].observations.findIndex(
        (entry) => entry.requirementId === source.requirementId,
      );
      const merged = mergeSupplementaryObservation(evidence[side].observations[index], source);
      if (index === -1) {
        evidence[side].observations.push(merged);
      } else {
        evidence[side].observations[index] = merged;
      }
    }
  }
};

const markIncompleteEvidence = (
  rows: Awaited<ReturnType<typeof assessParity>>["rows"],
  copied: Set<string>,
) => {
  for (const row of rows) {
    if (row.artifacts.some((path) => !copied.has(path))) {
      row.status = "unassessed";
      row.reasonCode = "evidence-incomplete";
      row.reason = "Referenced evidence was unavailable in the supplementary bundle.";
    }
  }
};

const addReferenceScreenshotPairs = async (args: {
  directory: string;
  copy: (root: string, artifact: string, prefix: string) => Promise<string>;
  copied: Set<string>;
}): Promise<
  { viewport: string; reference: string; candidate: string; qualification: string }[]
> => {
  const captureRoot = await realpath(args.directory);
  await args.copy(captureRoot, "capture-provenance.json", "reference-captures");
  const metadata = screenshotPairSchema.parse(
    await readJson(nodePath.join(captureRoot, "capture-provenance.json")),
  );
  const pairs = await Promise.all(
    (metadata.captures ?? []).map(async (capture) => {
      const artifact = safeRelative(nodePath.relative(captureRoot, await realpath(capture.path)));
      const reference = await args.copy(captureRoot, artifact, "reference-captures");
      const viewport = (
        capture.viewport?.name ??
        capture.name ??
        nodePath.basename(artifact, ".png")
      ).replace(/-0$/u, "");
      const candidate = `original/candidate-browser/${viewport}/root.png`;
      return args.copied.has(candidate) && args.copied.has(reference)
        ? {
            candidate,
            qualification: metadata.comparisonQualification ?? REFERENCE_QUALIFICATION,
            reference,
            viewport,
          }
        : undefined;
    }),
  );
  return pairs.filter((pair) => pair !== undefined);
};

export const writeSupplementaryAssessment = async (input: {
  runDirectory: string;
  sourceReviewDirectory: string;
  outputDirectory: string;
  referenceCapturesDirectory?: string;
  referenceRunDirectory?: string;
  candidateNavigationRunDirectory?: string;
}) => {
  const output = nodePath.join(
    await realpath(nodePath.dirname(nodePath.resolve(input.outputDirectory))),
    nodePath.basename(input.outputDirectory),
  );
  const builderRoot = await realpath(nodePath.resolve(import.meta.dirname, "../.."));
  if (output === builderRoot || output.startsWith(`${builderRoot}${nodePath.sep}`)) {
    throw new Error("Supplementary output must be outside the App Builder source tree.");
  }
  const roots = await Promise.all(
    [input.runDirectory, input.sourceReviewDirectory].map(
      async (rootPath) => await realpath(rootPath),
    ),
  );
  const [parityRoot, reviewRoot] = roots;
  if (!parityRoot || !reviewRoot) {
    throw new Error("Supplementary evidence roots are incomplete.");
  }
  for (const root of roots) {
    if (output === root || output.startsWith(`${root}${nodePath.sep}`)) {
      throw new Error("Supplementary output must be separate from the original evidence.");
    }
  }
  await mkdir(output, { recursive: false });
  const missing: string[] = [];
  const copied = new Set<string>();
  const recordMissing = (target: string, error: Error) => {
    missing.push(`${target}: ${error.message}`);
  };
  const copy = async (root: string, artifact: string, prefix: string) => {
    safeRelative(artifact);
    const target = `${prefix}/${artifact}`;
    if (copied.has(target)) {
      return target;
    }
    try {
      const source = await realpath(nodePath.join(root, artifact));
      const metadata = await stat(source);
      if (
        nodePath.relative(root, source).startsWith("..") ||
        !metadata.isFile() ||
        metadata.size === 0
      ) {
        throw new Error("Artifact is not a nonempty contained regular file.");
      }
      await mkdir(nodePath.dirname(nodePath.join(output, target)), { recursive: true });
      await copyFile(source, nodePath.join(output, target));
      copied.add(target);
    } catch (error) {
      recordMissing(target, error);
    }
    return target;
  };
  const evidence = parityEvidenceSchema.parse(
    JSON.parse(await readFile(nodePath.join(parityRoot, PARITY_EVIDENCE_FILE), "utf-8")),
  );
  const review = sourceReviewSchema.parse(
    JSON.parse(await readFile(nodePath.join(reviewRoot, OBSERVATIONS_FILE), "utf-8")),
  );
  if (review.schemaVersion !== SOURCE_REVIEW_VERSION) {
    throw new Error("Expected evaluator-owned source review schema.");
  }
  await mergeWorkflowReview(review, reviewRoot, copy);
  // Retain the original metadata and source review unchanged as provenance snapshots.
  for (const path of PRESERVED_REPORT_FILES) {
    await copy(parityRoot, path, ORIGINAL_PREFIX);
  }
  for (const path of SOURCE_SNAPSHOT_FILES) {
    await copy(reviewRoot, path, SOURCE_PREFIX);
  }
  const originalReport = captureMetadataSchema.parse(
    JSON.parse(await readFile(nodePath.join(parityRoot, REPORT_FILE), "utf-8")),
  );
  for (const capture of originalReport.captures ?? []) {
    for (const path of capture.files ?? []) {
      await copy(parityRoot, path, ORIGINAL_PREFIX);
    }
  }
  const rebase = async (
    value: Observation,
    root: string,
    prefix: string,
  ): Promise<Observation> => ({
    ...value,
    artifacts: await Promise.all(
      value.artifacts.map(async (path) => await copy(root, path, prefix)),
    ),
    assertions: await Promise.all(
      value.assertions.map(async (assertion) => ({
        ...assertion,
        artifacts: await Promise.all(
          assertion.artifacts.map(async (path) => await copy(root, path, prefix)),
        ),
      })),
    ),
  });
  await rebaseObservations(evidence, review, parityRoot, reviewRoot, rebase);
  const screenshotPairs =
    input.referenceCapturesDirectory !== undefined && input.referenceCapturesDirectory !== ""
      ? await addReferenceScreenshotPairs({
          copied,
          copy,
          directory: input.referenceCapturesDirectory,
        })
      : [];
  const assessment = await assessParity(evidence, (path) => copied.has(path));
  markIncompleteEvidence(assessment.rows, copied);
  const report = {
    anonymousEntryPriority: "excluded",
    assessment,
    generatedAt: new Date().toISOString(),
    generationRerun: false,
    kind: "supplementary-assessment",
    missingEvidence: missing,
    originalRunId: evidence.runId,
    screenshotPairs,
  };
  await writeFile(nodePath.join(output, PARITY_EVIDENCE_FILE), JSON.stringify(evidence, null, 2));
  await writeFile(nodePath.join(output, REPORT_FILE), JSON.stringify(report, null, 2));
  const rows = assessment.rows.map(
    (row) =>
      `| ${row.side} | ${row.requirementId} | ${row.status} | ${row.reason.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
  );
  const screenshotLines = screenshotPairs
    .map(
      (pair) =>
        `- ${pair.viewport}: [reference](${pair.reference}), [candidate](${pair.candidate}). ${pair.qualification}`,
    )
    .join("\n");
  const md = `# Supplementary self-reproduction assessment\n\nOriginal run: ${evidence.runId}. No generation or runtime rerun. Source review supplements retained behavioral evidence. Anonymous entry remains excluded from cleanup priority.\n\n| Side | Requirement | Status | Evidence finding |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Diagnostic initial screenshots\n\n${screenshotLines}\n`;
  await writeFile(nodePath.join(output, REPORT_MARKDOWN_FILE), md);
  const images = [...copied].filter((path) => path.endsWith(".png"));
  await writeFile(
    nodePath.join(output, "index.html"),
    renderHtmlReport({
      hasReferenceCaptures:
        input.referenceCapturesDirectory !== undefined && input.referenceCapturesDirectory !== "",
      images,
      rows: assessment.rows,
      runId: evidence.runId,
      screenshotPairs,
    }),
  );
  return report;
};
