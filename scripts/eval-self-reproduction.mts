import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { capturePreview } from "./design-quality/browser";
import {
  auditFramework,
  buildRequirements,
  frameworkRequirements,
  prioritizedGaps,
  readSource,
  type Requirement,
  type WorkflowEvidence,
} from "../evals/support/self-reproduction";

const { values } = parseArgs({
  options: {
    "candidate-root": { type: "string" },
    "arrusted-root": { type: "string" },
    "candidate-url": { type: "string" },
    "reference-url": { type: "string" },
    generator: { type: "string" },
    "generator-arg": { type: "string", multiple: true },
    "output-dir": { type: "string" },
    "brief-file": { type: "string" },
    "generation-timeout-ms": { type: "string" },
    "provider-request-timeout-ms": { type: "string" },
    help: { type: "boolean" },
  },
});

const root = resolve(import.meta.dirname, "..");
const now = new Date().toISOString();
const output = resolve(
  values["output-dir"] ?? join(".artifacts", "self-reproduction", now.replaceAll(/[.:]/gu, "-")),
);
const briefFile = resolve(values["brief-file"] ?? join("evals", "self-reproduction", "brief.md"));

function usage() {
  return `Usage: mise run eval:self-reproduction -- [options]

Runs one App Builder self-reproduction baseline. Generation is opt-in and must
be a normal App Builder workflow command; this evaluator never substitutes the
reference Builder backend or a mock model.

Options:
  --arrusted-root PATH      Local Arrusted checkout used by the Builder runtime.
  --generator FILE          Optional replacement executable for the normal Builder workflow.
  --generator-arg VALUE     Repeatable argument passed to that executable.
  --candidate-root PATH     Generated independent app root.
  --reference-url URL       Running handwritten App Builder URL for capture.
  --candidate-url URL       Running generated app URL for capture.
  --output-dir PATH         Owner-selected evidence directory.
  --brief-file PATH         Product-only generator input (default: checked-in brief).
  --generation-timeout-ms N Per-invocation Sandbox deadline in milliseconds (default: 600000).
  --provider-request-timeout-ms N Provider request deadline for this eval (default: 30000).

By default the evaluator launches the repository's normal mise run dev Eve
runtime and invokes it with the brief. Use --generator only to test another
normal Builder launcher. The generator receives only these environment variables:
  SELF_REPRODUCTION_BRIEF_PATH, SELF_REPRODUCTION_ANSWERS_PATH,
  SELF_REPRODUCTION_CANDIDATE_ROOT, SELF_REPRODUCTION_TRANSCRIPT_PATH

It must write the generated application to SELF_REPRODUCTION_CANDIDATE_ROOT and
may write a sanitized transcript to SELF_REPRODUCTION_TRANSCRIPT_PATH. Reference
source, screenshots, and evaluator findings are intentionally not exposed.`;
}

function requirementRow(requirement: Requirement) {
  return `<tr><td>${escape(requirement.status)}</td><th>${escape(requirement.title)}</th><td>${escape(requirement.expected)}</td><td>${escape(requirement.evidence.join(" "))}</td><td>${escape(requirement.likelyLayer)}</td><td>${escape(requirement.recommendation)}</td></tr>`;
}

function escape(value: string) {
  return value.replaceAll(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function reportHtml(report: {
  createdAt: string;
  generation: Record<string, unknown>;
  requirements: Requirement[];
  gaps: Record<string, unknown>[];
  captures: { label: string; files: string[]; status: string }[];
}) {
  const rows = report.requirements.map(requirementRow).join("");
  const gaps = report.gaps.length
    ? `<ol>${report.gaps.map((gap) => `<li><strong>${escape(String(gap.priority).toUpperCase())}: ${escape(String(gap.title))}</strong><p>${escape(String(gap.expected))}</p><p>${escape(String(gap.recommendation))}</p><small>${escape(String(gap.confirmed ? "Confirmed source gap" : "Blocked; cause not established"))}</small></li>`).join("")}</ol>`
    : "<p>No failed or blocked requirements were recorded.</p>";
  const captures = report.captures
    .map(
      (capture) =>
        `<li><strong>${escape(capture.label)}</strong>: ${escape(capture.status)}${capture.files.length ? ` — ${capture.files.map(escape).join(", ")}` : ""}</li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App Builder self-reproduction eval</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 24px;max-width:1280px;color:#202124}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}td:first-child{text-transform:uppercase;font-weight:700}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}li{margin:14px 0}</style><main><h1>App Builder self-reproduction eval</h1><p>One unassisted baseline. Static evidence does not prove runtime behavior. Missing or unavailable evidence is never reported as success.</p><p>${escape(report.createdAt)} · <a href="report.json">JSON evidence</a> · <a href="report.md">Markdown summary</a></p><h2>Generation</h2><pre>${escape(JSON.stringify(report.generation, null, 2))}</pre><h2>Prioritized gaps</h2>${gaps}<h2>Requirements</h2><table><thead><tr><th>Status</th><th>Requirement</th><th>Expected</th><th>Evidence</th><th>Layer</th><th>Recommended repair</th></tr></thead><tbody>${rows}</tbody></table><h2>Paired captures</h2><ul>${captures || "<li>Not captured.</li>"}</ul></main></html>`;
}

async function runGenerator(candidateRoot: string, transcript: string) {
  const arrustedRoot = values["arrusted-root"] ?? process.env.SELF_REPRODUCTION_ARRUSTED_ROOT;
  if (!values.generator && !arrustedRoot)
    return {
      status: "blocked",
      reason:
        "Provide --arrusted-root (or SELF_REPRODUCTION_ARRUSTED_ROOT) to launch the normal Builder runtime.",
    };
  const start = Date.now();
  const command = values.generator ?? process.execPath;
  const args = values.generator
    ? (values["generator-arg"] ?? [])
    : ["--import", "tsx", "scripts/self-reproduction-live.mts"];
  const resolvedArrustedRoot = arrustedRoot ? resolve(arrustedRoot) : undefined;
  const answersPath = resolve("evals/self-reproduction/answers.json");
  const result = await new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        NODE_ENV: process.env.NODE_ENV ?? "development",
        SELF_REPRODUCTION_BRIEF_PATH: briefFile,
        SELF_REPRODUCTION_ANSWERS_PATH: answersPath,
        SELF_REPRODUCTION_CANDIDATE_ROOT: candidateRoot,
        SELF_REPRODUCTION_TRANSCRIPT_PATH: transcript,
        SELF_REPRODUCTION_GENERATION_TIMEOUT_MS: values["generation-timeout-ms"] ?? "600000",
        SELF_REPRODUCTION_PROVIDER_REQUEST_TIMEOUT_MS:
          values["provider-request-timeout-ms"] ?? "30000",
        ...(resolvedArrustedRoot ? { SELF_REPRODUCTION_ARRUSTED_ROOT: resolvedArrustedRoot } : {}),
      },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (output += String(chunk)));
    child.on("error", () => resolve({ exitCode: null, output }));
    child.on("close", (exitCode: number | null) => resolve({ exitCode, output }));
  });
  await writeFile(join(resolve(transcript, ".."), "generator.log"), result.output, { mode: 0o600 });
  return {
    status: result.exitCode === 0 ? "completed" : result.exitCode === 75 ? "blocked" : "failed",
    exitCode: result.exitCode,
    elapsedMs: Date.now() - start,
  };
}

async function capture(label: string, url: string | undefined, sourceRoot: string | undefined) {
  if (!url) return { label, files: [], status: "unassessed: URL not supplied" };
  const destination = join(output, "captures", label);
  try {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const captures = await capturePreview({
      url,
      output: destination,
      tokens: {},
      scenarios: [],
      generatedSourcePaths: sourceRoot
        ? (await readSource(sourceRoot)).map((file) => file.path)
        : [],
    });
    return {
      label,
      files: captures.map((item) => `captures/${label}/${basename(item.path)}`),
      status: "captured",
    };
  } catch {
    return {
      label,
      files: [],
      status: "blocked: preview was unavailable or could not be captured",
    };
  }
}

async function main() {
  if (values.help) {
    console.log(usage());
    return;
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const candidateRoot = resolve(values["candidate-root"] ?? join(output, "candidate"));
  const generatorInput = join(output, "generator-input");
  await mkdir(generatorInput, { recursive: true, mode: 0o700 });
  await cp(briefFile, join(generatorInput, "brief.md"));
  await cp(resolve("evals/self-reproduction/answers.json"), join(generatorInput, "answers.json"));
  const transcript = join(output, "generation-transcript.jsonl");
  const generation = await runGenerator(candidateRoot, transcript);
  const referenceFiles = await readSource(root);
  let candidateFiles: Awaited<ReturnType<typeof readSource>> | undefined;
  try {
    candidateFiles = await readSource(candidateRoot);
  } catch {
    candidateFiles = undefined;
  }
  const referenceAudit = auditFramework(referenceFiles);
  const candidateAudit = candidateFiles ? auditFramework(candidateFiles) : undefined;
  const workflowEvidence = candidateFiles
    ? await readFile(join(candidateRoot, "self-reproduction.workflow-results.json"), "utf8")
        .then((value) => JSON.parse(value) as WorkflowEvidence)
        .catch(() => undefined)
    : undefined;
  const requirements = [
    ...buildRequirements(candidateFiles, workflowEvidence),
    ...frameworkRequirements(referenceAudit, "reference"),
    ...(candidateAudit
      ? frameworkRequirements(candidateAudit, "candidate")
      : frameworkRequirements(auditFramework([]), "candidate").map((requirement) => ({
          ...requirement,
          status: "blocked" as const,
          evidence: ["Candidate source was unavailable."],
        }))),
  ];
  const captures = await Promise.all([
    capture("reference", values["reference-url"], root),
    capture("candidate", values["candidate-url"], candidateFiles ? candidateRoot : undefined),
  ]);
  const report = {
    createdAt: now,
    input: {
      brief: "generator-input/brief.md",
      answers: "generator-input/answers.json",
      referenceSourceExposedToGenerator: false,
    },
    generation: {
      ...generation,
      candidateRoot,
      transcript: "generation-transcript.jsonl",
      sourceRevision: process.env.VERCEL_GIT_COMMIT_SHA ?? "local-unresolved",
    },
    reference: { framework: referenceAudit, sourceFiles: referenceFiles.length },
    candidate: candidateFiles
      ? { framework: candidateAudit, sourceFiles: candidateFiles.length }
      : { status: "blocked", reason: "No generated candidate was available." },
    requirements,
    gaps: prioritizedGaps(requirements),
    captures,
    limitations: [
      "Provider publication and provisioning are intentionally unverified in this isolated local benchmark.",
      "Visual captures are paired evidence; they are not pixel-identical acceptance criteria.",
      "Instant navigation remains unassessed until the candidate supplies focused @next/playwright instant() evidence.",
    ],
  };
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  const markdown = [
    "# App Builder self-reproduction eval",
    "",
    `Generated: ${now}`,
    "",
    `Generation: **${generation.status}**`,
    "",
    "## Prioritized gaps",
    "",
    ...report.gaps.map(
      (gap) => `- **${gap.priority} — ${gap.title}:** ${gap.expected} ${gap.recommendation}`,
    ),
    "",
    "See `report.json` and `index.html` for full evidence. Statuses are passed, failed, blocked, or unassessed; no missing evidence is counted as success.",
  ].join("\n");
  await writeFile(join(output, "report.md"), `${markdown}\n`, { mode: 0o600 });
  await writeFile(join(output, "index.html"), reportHtml(report), { mode: 0o600 });
  console.log(`Self-reproduction report: ${join(output, "index.html")}`);
}

try {
  await main();
} catch (error) {
  console.error(
    `Self-reproduction evaluation could not complete (${error instanceof Error ? error.name : "error"}).`,
  );
  process.exitCode = 1;
}
