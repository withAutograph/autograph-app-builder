/* oxlint-disable eslint/no-await-in-loop -- evidence files are written sequentially to preserve a recoverable audit trail. */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { activeBuilderModelId } from "../lib/integrations/active-model";

import {
  auditFramework,
  buildRequirements,
  frameworkRequirements,
  prioritizedGaps,
  readSource,
} from "../evals/support/self-reproduction";
import type { Requirement, WorkflowEvidence } from "../evals/support/self-reproduction";
import {
  digest,
  evidenceCompletion,
  evidenceSink,
  sanitizeEvidence,
} from "../evals/support/self-reproduction-evidence";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    "candidate-root": { type: "string" },
    "arrusted-root": { type: "string" },
    "candidate-url": { type: "string" },
    "reference-url": { type: "string" },
    "output-dir": { type: "string" },
    "generation-timeout-ms": { type: "string" },
    "report-only": { type: "boolean" },
    generator: { type: "string" },
    "generator-arg": { type: "string", multiple: true },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
});
const now = new Date().toISOString();
const output = resolve(
  values["output-dir"] ??
    process.env.SELF_REPRODUCTION_OUTPUT_DIR ??
    join(
      tmpdir(),
      "app-builder-self-reproduction",
      `${now.replaceAll(/[.:]/gu, "-")}-${randomUUID().slice(0, 8)}`,
    ),
);
const records: Record<string, unknown>[] = [];
const started = Date.now();
const captures: { label: string; files: string[]; status: string }[] = [];
let generation: Record<string, unknown> = { status: "pending" };
let input: Record<string, unknown> = { status: "pending" };
let revisions: Record<string, unknown> = {};
let settings: Record<string, unknown> = {};
let candidateFiles: Awaited<ReturnType<typeof readSource>> | undefined;
let referenceFiles: Awaited<ReturnType<typeof readSource>> | undefined;
let workflowEvidence: WorkflowEvidence | undefined;
let candidate: Record<string, unknown> = {
  status: "unavailable",
  reason: "No candidate export has been supplied.",
};
const errors: string[] = [];

async function artifactFile(name: string, content: string) {
  const path = join(output, name);
  await writeFile(`${path}.partial`, content, { mode: 0o600 });
  await rename(`${path}.partial`, path);
}

async function jsonFile(name: string, data: unknown) {
  await artifactFile(name, `${JSON.stringify(sanitizeEvidence(data), null, 2)}\n`);
}

function revision(directory: string | undefined) {
  if (!directory) return { status: "unavailable", reason: "Source checkout not supplied." };
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
      changes: execFileSync("git", ["status", "--porcelain"], {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch {
    return { status: "unavailable", reason: "Git revision could not be read." };
  }
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
        `<li><strong>${escape(capture.label)}</strong>: ${escape(capture.status)}${capture.files.length ? ` — ${capture.files.map((file) => `<a href="${escape(file)}">${escape(basename(file))}</a>${/\.(?:png|jpe?g|webp)$/iu.test(file) ? `<img src="${escape(file)}" alt="${escape(capture.label)} ${escape(basename(file))}" style="display:block;max-width:100%;margin:12px 0">` : ""}`).join(", ")}` : ""}</li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App Builder self-reproduction eval</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 24px;max-width:1280px;color:#202124}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}td:first-child{text-transform:uppercase;font-weight:700}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}li{margin:14px 0}</style><main><h1>App Builder self-reproduction eval</h1><p>One unassisted baseline. Static evidence does not prove runtime behavior. Missing or unavailable evidence is never reported as success.</p><p>${escape(report.createdAt)} · <a href="report.json">JSON evidence</a> · <a href="report.md">Markdown summary</a></p><h2>Generation</h2><pre>${escape(JSON.stringify(report.generation, null, 2))}</pre><h2>Prioritized gaps</h2>${gaps}<h2>Requirements</h2><table><thead><tr><th>Status</th><th>Requirement</th><th>Expected</th><th>Evidence</th><th>Layer</th><th>Recommended repair</th></tr></thead><tbody>${rows}</tbody></table><h2>Paired captures</h2><ul>${captures || "<li>Not captured.</li>"}</ul></main></html>`;
}

async function runGenerator(arrustedRoot: string | undefined) {
  if (values["report-only"]) return { status: "not-run", reason: "Report-only mode selected." };
  if (!values.generator && !arrustedRoot)
    return {
      status: "blocked",
      reason:
        "Set SELF_REPRODUCTION_ARRUSTED_ROOT or --arrusted-root to the canonical Arrusted checkout.",
    };
  const deadline = Number(values["generation-timeout-ms"] ?? "900000");
  if (!Number.isSafeInteger(deadline) || deadline <= 0)
    throw new Error("Generation timeout must be a positive integer.");
  const args = values.generator
    ? (values["generator-arg"] ?? [])
    : [
        "--import",
        "tsx",
        "scripts/run-eve-eval.mts",
        "--gate-a-profile",
        "sandbox",
        "--gate-a-source-root",
        resolve(arrustedRoot!),
        "--live-model",
        "self-reproduction",
        "--strict",
        "--verbose",
        "--skip-report",
        "--json",
        "--timeout",
        String(deadline),
      ];
  const command = values.generator ?? process.execPath;
  settings = {
    ...settings,
    command,
    args,
    timeoutMs: deadline,
    strict: true,
    liveModel: !values.generator,
  };
  await jsonFile("settings.json", settings);
  const stdout = evidenceSink(
    join(output, "eval-output.log"),
    join(output, "generation-transcript.jsonl"),
    records,
  );
  const stderr = evidenceSink(
    join(output, "eval.log"),
    join(output, "generation-transcript.jsonl"),
    records,
  );
  let rawOutput = "";
  let interrupted: string | undefined;
  const childStarted = Date.now();
  const result = await new Promise<{
    exitCode: number | null;
    signal?: string | null;
    error?: string;
  }>((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: process.env,
    });
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (interrupted) return;
      interrupted = reason;
      // Forward termination to the native eval process group, including its broker.
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            /* Already exited. */
          }
        }
      };
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 5000);
    };
    const onInt = () => stop("SIGINT");
    const onTerm = () => stop("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    const timer = setTimeout(() => stop("generation deadline exceeded"), deadline + 30_000);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      rawOutput += chunk;
      stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => stderr.write(chunk));
    let spawnError: string | undefined;
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      stdout.end();
      stderr.end();
      resolve({ exitCode, signal, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
  // --verbose adds checkpoint lines before the final native JSON document.
  let native: Record<string, unknown> | undefined;
  for (const match of rawOutput.matchAll(/(?:^|\n)(?=\{)/gu)) {
    try {
      const parsed = JSON.parse(rawOutput.slice(match.index + match[0].length));
      if (Array.isArray(parsed.results)) {
        native = parsed;
        break;
      }
    } catch {
      /* A diagnostic or partial JSON document. */
    }
  }
  await jsonFile(
    "native-result.json",
    native ?? {
      status: "unavailable",
      reason:
        "Native runner did not emit complete result JSON; retained incremental transcript and diagnostics.",
    },
  );
  const completion = evidenceCompletion(result.exitCode, records);
  const nativeResults = native?.results as { id?: string; verdict?: string }[] | undefined;
  const nativePassed =
    nativeResults?.length === 1 &&
    nativeResults[0]?.id === "self-reproduction" &&
    nativeResults[0]?.verdict === "passed";
  return {
    ...completion,
    ...result,
    ...(interrupted ? { status: "failed", interrupted } : {}),
    elapsedMs: Date.now() - childStarted,
    nativeResult: "native-result.json",
    ...(native
      ? nativePassed
        ? {}
        : { status: "failed", reason: "Native strict eval did not pass." }
      : { status: "failed", reason: "Native result JSON unavailable; evidence is incomplete." }),
  };
}

async function capture(label: string, url: string | undefined, sourceRoot: string | undefined) {
  if (!url) return { label, files: [], status: "unassessed: URL not supplied" };
  const destination = join(output, "captures", label);
  try {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const { capturePreview } = await import("./design-quality/browser");
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
      files: await readdir(destination)
        .then((files) => files.map((file) => `captures/${label}/${file}`))
        .catch(() => []),
      status:
        "blocked: preview was unavailable or could not be captured; any partial files are retained",
    };
  }
}

const blockedFramework = (side: "reference" | "candidate") =>
  frameworkRequirements(auditFramework([]), side).map((item) => ({
    ...item,
    status: "blocked" as const,
    evidence: [`${side} source was unavailable.`],
  }));

async function saveReport() {
  const requirements = [
    ...buildRequirements(candidateFiles, workflowEvidence),
    ...(referenceFiles
      ? frameworkRequirements(auditFramework(referenceFiles), "reference")
      : blockedFramework("reference")),
    ...(candidateFiles
      ? frameworkRequirements(auditFramework(candidateFiles), "candidate")
      : blockedFramework("candidate")),
  ];
  const receipt = {
    version: 1,
    createdAt: now,
    elapsedMs: Date.now() - started,
    input,
    settings,
    revisions,
    generation,
    transcript: {
      path: "generation-transcript.jsonl",
      records: records.length,
      status: records.length ? "available" : "unavailable",
    },
    toolOutcomes: records
      .filter((record) => record.kind === "turn-completed")
      .flatMap((record) => (Array.isArray(record.toolCalls) ? record.toolCalls : [])),
    candidate,
    errors,
  };
  const report = {
    ...receipt,
    reference: referenceFiles
      ? { framework: auditFramework(referenceFiles), sourceFiles: referenceFiles.length }
      : { status: "unavailable" },
    requirements,
    gaps: prioritizedGaps(requirements),
    captures: captures.length
      ? captures
      : [
          { label: "reference", files: [], status: "unassessed: capture has not run" },
          { label: "candidate", files: [], status: "unassessed: capture has not run" },
        ],
    limitations: [
      "No deployment, provider publication, or provisioning is performed by this report pipeline.",
      "The native eval retains reviewed sandbox status but does not export a candidate tree; supply --candidate-root with --report-only for an independently exported tree.",
      "Paired captures require running reference and candidate URLs and Playwright Chromium. They do not establish runtime workflow or instant-navigation acceptance.",
    ],
  };
  await jsonFile("receipt.json", receipt);
  await jsonFile("candidate-inventory.json", candidate);
  await jsonFile("report.json", report);
  const markdown = [
    "# App Builder self-reproduction eval",
    "",
    `Generated: ${now}`,
    "",
    `Generation: **${generation.status}**; elapsed: ${receipt.elapsedMs} ms`,
    "",
    `Candidate: ${candidate.status}. ${candidate.reason ?? ""}`,
    "",
    "## Paired captures",
    "",
    ...report.captures.map((item) => `- ${item.label}: ${item.status}`),
    "",
    "## Prioritized gaps",
    "",
    ...report.gaps.map(
      (gap) => `- **${gap.priority} — ${gap.title}:** ${gap.expected} ${gap.recommendation}`,
    ),
    "",
    ...errors.map((error) => `Error: ${error}`),
    "",
    "See receipt.json, report.json and index.html. Missing evidence is never counted as success.",
  ].join("\n");
  await artifactFile("report.md", `${sanitizeEvidence(markdown)}\n`);
  await artifactFile("index.html", reportHtml(sanitizeEvidence(report) as typeof report));
}

async function main() {
  if (values.help) {
    console.log(`Usage: mise run eval:self-reproduction -- [--arrusted-root PATH] [--output-dir EXTERNAL_PATH]
  [--reference-url URL] [--candidate-url URL] [--generation-timeout-ms N]
  [--report-only --candidate-root PATH]

Explicitly runs the native live Eve benchmark with strict assertions and writes
sanitized evidence outside the source tree. No publication or deployment.
--report-only audits an existing candidate without running generation.
--generator FILE and repeatable --generator-arg VALUE select a test launcher.
The checked-in brief and fixed answers are always preserved unchanged.`);
    return;
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const actualOutput = await realpath(output);
  const inside = relative(await realpath(root), actualOutput);
  if (!inside || (!inside.startsWith(`..${sep}`) && inside !== ".."))
    throw new Error("Evidence directory must be outside the App Builder source tree.");
  console.log(`Self-reproduction evidence: ${output}`);
  await writeFile(join(output, "generation-transcript.jsonl"), "", { mode: 0o600 });
  await jsonFile("native-result.json", {
    status: "unavailable",
    reason: "Native eval has not completed.",
  });
  await jsonFile("settings.json", {
    status: "unavailable",
    reason: "Settings have not been read.",
  });
  await jsonFile("revisions.json", {
    status: "unavailable",
    reason: "Revisions have not been read.",
  });
  await writeFile(join(output, "eval.log"), "", { mode: 0o600 });
  await writeFile(join(output, "eval-output.log"), "", { mode: 0o600 });
  await saveReport();
  try {
    const arrustedRoot =
      values["arrusted-root"] ??
      process.env.SELF_REPRODUCTION_ARRUSTED_ROOT ??
      [
        resolve(root, "..", "arrusted-development"),
        join(homedir(), "Documents/GitHub/withAutograph/arrusted-development"),
      ].find((directory) => existsSync(directory));
    revisions = { builder: revision(root), arrusted: revision(arrustedRoot) };
    await jsonFile("revisions.json", revisions);
    await mkdir(join(output, "generator-input"), { mode: 0o700, recursive: true });
    const inputs: Record<string, unknown> = {};
    for (const file of ["brief.md", "answers.json"]) {
      const content = await readFile(join(root, "evals/self-reproduction", file), "utf-8");
      await writeFile(join(output, "generator-input", file), content, { mode: 0o600 });
      inputs[file] = { path: `generator-input/${file}`, sha256: digest(content) };
    }
    input = { status: "preserved", files: inputs, referenceSourceExposedToGenerator: false };
    await mkdir(join(output, "settings-source"), { mode: 0o700, recursive: true });
    for (const file of [
      "agent/agent.ts",
      "lib/integrations/active-model.ts",
      "evals/evals.config.ts",
    ]) {
      const content = await readFile(join(root, file), "utf-8");
      await writeFile(
        join(output, "settings-source", basename(file)),
        String(sanitizeEvidence(content)),
        { mode: 0o600 },
      );
    }
    settings = {
      status: "preserved",
      source: "settings-source/",
      model: activeBuilderModelId,
      reasoningConfiguration:
        "Preserved verbatim in settings-source/agent.ts; effective runtime identity is retained in transcript events.",
      runtimeIdentity: "See session.started events in generation-transcript.jsonl",
      publication: "disabled by sandbox eval profile",
    };
    await jsonFile("settings.json", settings);
    generation = { status: "running" };
    await saveReport();
    generation = await runGenerator(arrustedRoot);
    await saveReport();
    referenceFiles = await readSource(root);
    const candidateRoot = values["candidate-root"] ? resolve(values["candidate-root"]) : undefined;
    if (candidateRoot) {
      try {
        candidateFiles = await readSource(candidateRoot);
        if (!candidateFiles.length)
          throw new Error("Candidate contains no application source files.");
        // Persist the audited source bytes, never the candidate's credentials or dependency tree.
        for (const file of candidateFiles) {
          const destination = join(output, "candidate", file.path);
          await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
          await writeFile(destination, String(sanitizeEvidence(file.content)), { mode: 0o600 });
        }
        candidate = {
          status: "available",
          provenance: "operator-supplied export; not automatically attributed to this generation",
          revision: revision(candidateRoot),
          files: candidateFiles.map((file) => ({
            path: `candidate/${file.path}`,
            sha256: digest(String(sanitizeEvidence(file.content))),
          })),
        };
        workflowEvidence = await readFile(
          join(candidateRoot, "self-reproduction.workflow-results.json"),
          "utf-8",
        )
          .then((value) => JSON.parse(value) as WorkflowEvidence)
          .catch(() => undefined);
        if (workflowEvidence) await jsonFile("workflow-results.json", workflowEvidence);
      } catch (error) {
        candidateFiles = undefined;
        candidate = {
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    } else
      candidate = {
        status: "unavailable",
        reason:
          "The reviewed native Eve sandbox change set has no candidate export API wired to this eval. Framework and workflow comparison are blocked until a candidate tree is exported.",
      };
    await saveReport();
    captures.push(
      ...(await Promise.all([
        capture("reference", values["reference-url"], root),
        capture("candidate", values["candidate-url"], candidateRoot),
      ])),
    );
  } catch (error) {
    errors.push(String(sanitizeEvidence(error instanceof Error ? error.message : String(error))));
    generation = { ...generation, status: "failed" };
  } finally {
    await saveReport();
  }
  if (!["completed", "not-run"].includes(String(generation.status)) || errors.length)
    process.exitCode = 1;
  if (values.json) console.log(await readFile(join(output, "report.json"), "utf-8"));
  else console.log(`Self-reproduction report: ${join(output, "index.html")}`);
}

try {
  await main();
} catch (error) {
  console.error(String(sanitizeEvidence(error instanceof Error ? error.message : String(error))));
  process.exitCode = 1;
}
