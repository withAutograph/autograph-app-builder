/* oxlint-disable eslint/no-await-in-loop -- preserve ordered evidence copies and deterministic merges. */
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assessParity,
  desktopViewports,
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
  const output = join(
    await realpath(dirname(resolve(input.outputDirectory))),
    basename(input.outputDirectory),
  );
  const builderRoot = await realpath(resolve(import.meta.dirname, "../.."));
  if (output === builderRoot || output.startsWith(`${builderRoot}${sep}`))
    throw new Error("Supplementary output must be outside the App Builder source tree.");
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
      const metadata = await stat(source);
      if (relative(root, source).startsWith("..") || !metadata.isFile() || metadata.size === 0)
        throw new Error("Artifact is not a nonempty contained regular file.");
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
      const artifact = safeRelative(relative(captureRoot, await realpath(capture.path)));
      const reference = await copy(captureRoot, artifact, "reference-captures");
      const viewport = String(
        capture.viewport?.name ?? capture.name ?? basename(artifact, ".png"),
      ).replace(/-0$/u, "");
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
  if (!input.referenceCapturesDirectory) {
    const fixturePath = "captures/reference/fixture.json";
    const fixtureArtifact = `original/${fixturePath}`;
    const reportedFiles = new Set<string>(
      (originalReport.captures ?? []).flatMap(
        (capture: { files?: string[] }) => capture.files ?? [],
      ),
    );
    const referenceFiles = new Set<string>(
      (originalReport.captures ?? [])
        .filter((capture: { label?: string }) => capture.label === "reference")
        .flatMap((capture: { files?: string[] }) => capture.files ?? []),
    );
    if (referenceFiles.has(fixturePath) && copied.has(fixtureArtifact)) {
      try {
        const fixtures: unknown = JSON.parse(
          await readFile(join(output, fixtureArtifact), "utf-8"),
        );
        if (!Array.isArray(fixtures))
          throw new Error("Expected retained reference fixture receipts.");
        await copy(roots[0]!, "candidate-browser-comparison.json", "original");
        let candidateOutcomes: {
          viewport?: string;
          fixture?: {
            status?: string;
            matched?: boolean;
            draft?: { appName?: string; brief?: string };
          };
        }[] = [];
        if (copied.has("original/candidate-browser-comparison.json")) {
          const comparison = JSON.parse(
            await readFile(join(output, "original/candidate-browser-comparison.json"), "utf-8"),
          );
          candidateOutcomes = comparison.output?.outcomes ?? [];
        }
        for (const viewport of desktopViewports) {
          const fixture = fixtures.find(
            (item) =>
              item?.status === "ready" &&
              item.state === "authenticated-durable-draft" &&
              item.viewport?.width === viewport.width &&
              item.viewport?.height === viewport.height,
          );
          const referencePath = `captures/reference/${viewport.name}-0.png`;
          const reference = `original/${referencePath}`;
          const candidate = `original/candidate-browser/${viewport.name}/root.png`;
          if (
            !fixture ||
            !referenceFiles.has(referencePath) ||
            !copied.has(reference) ||
            !copied.has(candidate) ||
            !reportedFiles.has(`candidate-browser/${viewport.name}/root.png`)
          ) {
            missing.push(
              `paired-capture/${viewport.name}: blocked; ready authenticated fixture and both report-listed screenshots are required.`,
            );
            continue;
          }
          const candidateFixture = candidateOutcomes.find(
            (item) => item.viewport === viewport.name,
          )?.fixture;
          const matched =
            candidateFixture?.status === "prepared" &&
            candidateFixture.matched === true &&
            candidateFixture.draft?.appName === fixture.draft?.appName &&
            candidateFixture.draft?.brief === fixture.draft?.brief;
          screenshotPairs.push({
            candidate,
            qualification: matched
              ? "The reference authenticated owner and candidate visible controls use matching synthetic draft values. This is a layout comparison; candidate authentication and durable persistence are not established by matching inputs."
              : "Authenticated durable reference draft versus candidate diagnostic screen. Matching visible inputs are unassessed; authentication and persistence parity are not established.",
            reference,
            viewport: viewport.name,
          });
        }
      } catch {
        missing.push(
          "paired-capture: blocked; retained reference fixture provenance could not be read.",
        );
      }
    } else {
      missing.push(
        "paired-capture: blocked; no report-listed authenticated reference fixture receipt was retained.",
      );
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
  const counts = sides
    .map((side) => {
      const sideRows = assessment.rows.filter((row) => row.side === side);
      return `<tr><th>${side}</th>${["passed", "failed", "blocked", "unassessed"].map((status) => `<td>${sideRows.filter((row) => row.status === status).length}</td>`).join("")}</tr>`;
    })
    .join("");
  const priorities = assessment.rows.filter(
    (row) =>
      row.side === "candidate" &&
      row.status === "failed" &&
      row.requirementId !== "anonymous-entry",
  );
  const pairMarkup = screenshotPairs
    .map(
      (pair) =>
        `<section><h3>${escape(pair.viewport)}</h3><p class="qualification">${escape(pair.qualification)}</p><div class="pair"><figure><figcaption>Handwritten reference</figcaption><a href="${escape(pair.reference)}"><img src="${escape(pair.reference)}" alt="Reference initial screen"></a></figure><figure><figcaption>Generated candidate</figcaption><a href="${escape(pair.candidate)}"><img src="${escape(pair.candidate)}" alt="Candidate default screen"></a></figure></div></section>`,
    )
    .join("");
  const findings = assessment.rows
    .map(
      (row) =>
        `<tr><td>${escape(row.side)}</td><th>${escape(row.requirementId)}</th><td class="${row.status}">${row.status}</td><td>${escape(row.reason)}</td><td>${row.artifacts.map((path, index) => `<a href="${escape(path)}">Evidence ${index + 1}</a>`).join("<br>")}</td></tr>`,
    )
    .join("");
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Supplementary self-reproduction assessment</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:32px auto;padding:0 24px;max-width:1500px;color:#202124;background:#fafafa}h1{font-size:28px;margin-bottom:8px}h2{margin-top:32px}a{color:#1555a3}table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #ddd;vertical-align:top}thead{background:#eee}.summary{max-width:650px}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;background:white;border:1px solid #ddd}figcaption{padding:10px;font-weight:600}img{display:block;width:100%;height:auto}.qualification{color:#555}.failed{color:#a12622;font-weight:600}.passed{color:#256029}.findings{overflow-x:auto}.provenance{display:flex;flex-wrap:wrap;gap:16px}.note{max-width:1000px}li{margin:6px 0}
</style></head><body><h1>How close did the generated app get?</h1><p class="note">Supplementary assessment of <strong>${escape(evidence.runId)}</strong>. Existing runtime evidence plus evaluator source review; no generation or runtime rerun. Counts describe requirement evidence, not a numerical similarity score. Anonymous entry is excluded from cleanup priority.</p><table class="summary"><thead><tr><th>Application</th><th>Passed</th><th>Failed</th><th>Blocked</th><th>Unassessed</th></tr></thead><tbody>${counts}</tbody></table><p class="provenance"><a href="original/report.json">Original runtime report</a><a href="original/revisions.json">Original revisions</a><a href="source-review/source-evidence.json">Source review provenance</a>${input.referenceCapturesDirectory ? '<a href="reference-captures/capture-provenance.json">Capture provenance</a>' : copied.has("original/captures/reference/fixture.json") ? '<a href="original/captures/reference/fixture.json">Capture fixture provenance</a>' : ""}<a href="report.json">Assessment JSON</a><a href="report.md">Markdown report</a></p><h2>Initial screen comparison</h2>${pairMarkup || "<p>No paired captures retained.</p>"}<h2>Confirmed candidate gaps</h2><p>Workflow failures appear before framework and capture findings. These are separate requirements, not necessarily independent root causes.</p><ul>${priorities.map((row) => `<li><strong>${escape(row.requirementId)}</strong> — ${escape(row.reason)}</li>`).join("")}</ul><h2>All requirement outcomes</h2><div class="findings"><table><thead><tr><th>Side</th><th>Requirement</th><th>Status</th><th>Finding</th><th>Artifacts</th></tr></thead><tbody>${findings}</tbody></table></div><details><summary>Other retained screenshots (${images.length})</summary><ul>${images.map((path) => `<li><a href="${escape(path)}">${escape(path)}</a></li>`).join("")}</ul></details></body></html>`,
  );
  return report;
}
