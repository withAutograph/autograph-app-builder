/* oxlint-disable eslint/no-await-in-loop -- evidence files are written sequentially to preserve a recoverable audit trail. */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { create as createTar } from "tar";
import { prepareSelfReproductionTemplateSource } from "../evals/support/self-reproduction-template-source";
import { activeBuilderModelId } from "../lib/integrations/active-model";
import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  validateLocalVercelOidcClaims,
} from "../lib/eve/local-vercel-oidc";

import {
  auditFramework,
  buildRequirements,
  frameworkRequirements,
  prioritizedGaps,
  readSource,
} from "../evals/support/self-reproduction";
import type { WorkflowEvidence } from "../evals/support/self-reproduction";
import {
  candidateExportFromEvidence,
  candidateExportProvenanceFromEvidence,
  digest,
  evidenceCompletion,
  evidenceSink,
  sanitizeEvidence,
} from "../evals/support/self-reproduction-evidence";
import {
  assessParity,
  captureStates,
  desktopViewports,
  workflowMatrix,
} from "../evals/support/self-reproduction-parity";
import type {
  Assessment,
  Observation,
  ParityEvidence,
} from "../evals/support/self-reproduction-parity";
import {
  candidateRuntimeCaptureFailureObservations,
  candidateRuntimeFailureObservations,
} from "../evals/support/self-reproduction-runtime";
import type { CandidateRuntimeReceipt } from "../evals/support/self-reproduction-runtime";
import { runSandboxRuntimeComparison } from "../evals/support/self-reproduction-runtime-comparison";
import { mergeRuntimeEvidence } from "../evals/support/self-reproduction-runtime-evidence";
import { sandboxBrowserComparison } from "../evals/support/self-reproduction-runtime-browser";
import {
  candidateWorkflowReceipts,
  sandboxCandidateWorkflowComparison,
} from "../evals/support/self-reproduction-candidate-workflows";
import type { CandidateWorkflowOutcome } from "../evals/support/self-reproduction-candidate-workflows";
import { sandboxCandidateInteractionCaptures } from "../evals/support/self-reproduction-candidate-captures";
import { runtimeReceiptSchema } from "../evals/support/self-reproduction-parity-evidence";
import { startSelfReproductionReferenceRuntime } from "../evals/support/self-reproduction-reference-runtime";
import { parityEvidenceFromReceipts } from "../evals/support/self-reproduction-parity-evidence";
import type { TrustedBrowserWorkflowAdapter } from "../evals/support/self-reproduction-workflow-adapters";
import {
  runPairedCaptureEvidence,
  unavailableCaptureObservations,
  writePairedCaptureManifest,
} from "../evals/support/self-reproduction-captures";
import type { CaptureAdapter, PairedCaptureRun } from "../evals/support/self-reproduction-captures";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    "candidate-root": { type: "string" },
    "arrusted-root": { type: "string" },
    "candidate-url": { type: "string" },
    "candidate-runtime": { type: "boolean" },
    "debug-prerender": { type: "boolean" },
    "reference-url": { type: "string" },
    "reference-runtime": { type: "boolean" },
    "reference-navigation": { type: "boolean" },
    "reference-navigation-evidence": { type: "string" },
    "mise-executable": { type: "string" },
    "capture-adapter": { type: "string" },
    "workflow-adapter-module": { type: "string" },
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
let parityAssessment: Assessment | undefined;
let pairedCaptures: PairedCaptureRun | undefined;
let trustedWorkflowReceipts: unknown[] = [];
let sandboxWorkflowReceipts: unknown[] = [];
let sandboxCaptureObservations: Observation[] = [];
let referenceNavigationReceipts: unknown[] = [];
let trustedFrameworkReceipts: unknown[] = [];
let referenceFixtureRoot: string | undefined;
let referenceDatabaseUrl: string | undefined;
let stopReference: (() => Promise<void>) | undefined;
let candidateRuntime: CandidateRuntimeReceipt | { status: "not-run" | "failed"; reason: string } = {
  status: "not-run",
  reason: "Candidate runtime evaluation was not requested.",
};
let candidate: Record<string, unknown> = {
  status: "unavailable",
  reason: "No candidate export has been supplied.",
};
const errors: string[] = [];

async function runConfiguredPairedCaptures() {
  const adapterFile =
    values["capture-adapter"] ??
    (values["reference-url"] && values["candidate-url"]
      ? join(root, "evals/self-reproduction/default-capture-adapter.ts")
      : undefined);
  if (!adapterFile) return;
  if (!values["reference-url"] || !values["candidate-url"])
    throw new Error("--capture-adapter requires both --reference-url and --candidate-url.");
  const evaluatorRoot = await realpath(join(root, "evals"));
  const resolvedAdapter = await realpath(resolve(adapterFile));
  const adapterRelative = relative(evaluatorRoot, resolvedAdapter);
  if (
    !adapterRelative ||
    adapterRelative === ".." ||
    adapterRelative.startsWith(`..${sep}`) ||
    adapterRelative.startsWith(sep)
  )
    throw new Error("Capture adapter must be an evaluator-owned module under evals/.");
  const loaded = (await import(pathToFileURL(resolvedAdapter).href)) as {
    createCaptureAdapters?: (input: {
      referenceURL: string;
      candidateURL: string;
    }) => Promise<Partial<Record<"reference" | "candidate", CaptureAdapter>>>;
  };
  if (typeof loaded.createCaptureAdapters !== "function")
    throw new Error("Capture adapter must export createCaptureAdapters().");
  const adapters = await loaded.createCaptureAdapters({
    referenceURL: values["reference-url"],
    candidateURL: values["candidate-url"],
  });
  try {
    pairedCaptures = await runPairedCaptureEvidence({ outputRoot: output, adapters });
  } catch {
    const observations = unavailableCaptureObservations(
      "The evaluator could not launch or retain its paired browser capture runtime.",
    );
    pairedCaptures = {
      observations,
      manifest: await writePairedCaptureManifest(output, observations),
    };
  }
  captures.push({
    label: "paired-state-manifest",
    files: ["parity/captures/manifest.json"],
    status: "captured",
  });
}

type WorkflowAdapterFactory = (input: {
  referenceUrl?: string;
  referenceFixtureRoot?: string;
  candidateUrl?: string;
  outputRoot: string;
}) =>
  | Partial<Record<"reference" | "candidate", TrustedBrowserWorkflowAdapter>>
  | Promise<Partial<Record<"reference" | "candidate", TrustedBrowserWorkflowAdapter>>>;

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

async function runConfiguredWorkflowAdapters(candidateRoot: string | undefined) {
  const adapterFile =
    values["workflow-adapter-module"] ??
    process.env.SELF_REPRODUCTION_WORKFLOW_ADAPTER_MODULE ??
    join(root, "evals/self-reproduction/workflow-adapter.ts");
  const resolvedAdapter = await realpath(resolve(adapterFile));
  const evaluatorRoot = await realpath(join(root, "evals"));
  if (
    !within(evaluatorRoot, resolvedAdapter) ||
    within(output, resolvedAdapter) ||
    (candidateRoot && within(candidateRoot, resolvedAdapter))
  )
    throw new Error("Workflow adapter module must be evaluator-owned and under evals/.");
  const loaded = (await import(pathToFileURL(resolvedAdapter).href)) as {
    createWorkflowAdapters?: WorkflowAdapterFactory;
  };
  if (typeof loaded.createWorkflowAdapters !== "function")
    throw new Error("Workflow adapter module must export createWorkflowAdapters().");
  const referenceUrl = values["reference-url"] ?? process.env.SELF_REPRODUCTION_REFERENCE_URL;
  const candidateUrl = values["candidate-url"] ?? process.env.SELF_REPRODUCTION_CANDIDATE_URL;
  const adapters = await loaded.createWorkflowAdapters({
    ...(referenceUrl ? { referenceUrl } : {}),
    ...(referenceFixtureRoot ? { referenceFixtureRoot } : {}),
    ...(candidateUrl ? { candidateUrl } : {}),
    outputRoot: output,
  });
  const adapterSides = (["reference", "candidate"] as const).filter((side) => adapters[side]);
  if (adapterSides.length === 0) {
    trustedWorkflowReceipts = (["reference", "candidate"] as const).flatMap((side) =>
      workflowMatrix
        .filter((workflow) => workflow.id !== "anonymous-entry")
        .map((workflow) => ({
          schemaVersion: "self-reproduction-runtime-receipt/v1" as const,
          producer: "evaluator" as const,
          side,
          observation: {
            requirementId: workflow.id,
            disposition: "not-run" as const,
            reason: "The checked-in evaluator adapter has no runtime binding for this side.",
            method: "none" as const,
            artifacts: [],
            assertions: [],
          },
        })),
    );
    // oxlint-disable-next-line eslint/no-use-before-define -- artifact writer is initialized before runtime execution
    await jsonFile("trusted-workflow-receipts.json", trustedWorkflowReceipts);
    return;
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const { runTrustedBrowserWorkflows } =
      await import("../evals/support/self-reproduction-workflow-adapters");
    const run = await runTrustedBrowserWorkflows({ browser, outputRoot: output, adapters });
    trustedWorkflowReceipts = run.receipts;
    const { runTrustedFrameworkEvidence } =
      await import("../evals/support/self-reproduction-framework");
    const { createDefaultFrameworkAdapter } =
      await import("../evals/support/self-reproduction-framework-adapters");
    const framework = await runTrustedFrameworkEvidence({
      browser,
      outputRoot: output,
      adapters: {
        ...(referenceUrl && referenceFiles
          ? {
              reference: createDefaultFrameworkAdapter({
                side: "reference",
                files: referenceFiles,
                baseURL: referenceUrl,
              }),
            }
          : {}),
        ...(candidateUrl && candidateFiles
          ? {
              candidate: createDefaultFrameworkAdapter({
                side: "candidate",
                files: candidateFiles,
                baseURL: candidateUrl,
              }),
            }
          : {}),
      },
    });
    trustedFrameworkReceipts = framework.receipts;
    // oxlint-disable-next-line eslint/no-use-before-define -- writer is initialized before runtime execution
    await jsonFile("trusted-framework-receipts.json", trustedFrameworkReceipts);
  } finally {
    await browser.close();
    // oxlint-disable-next-line eslint/no-use-before-define -- artifact writer is initialized before runtime execution
    await jsonFile("trusted-workflow-receipts.json", trustedWorkflowReceipts);
  }
}

function loadProjectOidc(): { token: string; teamId: string; projectId: string } {
  const token = parseLocalVercelOidcToken(
    readOwnerBoundLocalFile(join(root, ".env.local"), { confidential: true }),
  );
  const project = parseLinkedVercelProject(
    readOwnerBoundLocalFile(join(root, ".vercel/project.json"), { confidential: false }),
  );
  validateLocalVercelOidcClaims({
    token,
    project,
    nowEpochSeconds: Math.floor(Date.now() / 1000),
  });
  return { token, teamId: project.orgId, projectId: project.projectId };
}

async function readCandidateSource(
  directory: string,
  current = directory,
): Promise<Awaited<ReturnType<typeof readSource>>> {
  const entries = await readdir(current, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if ([".git", ".next", "node_modules", "coverage"].includes(entry.name)) return [];
      const path = join(current, entry.name);
      if (entry.isDirectory()) return readCandidateSource(directory, path);
      if (
        !entry.isFile() ||
        !/^(?:[^.]+|.*\.(?:[cm]?[jt]sx?|css|mdx?|json|pkl|toml|ya?ml))$/u.test(entry.name)
      )
        return [];
      return [{ path: relative(directory, path), content: await readFile(path, "utf-8") }];
    }),
  );
  return nested.flat();
}

async function trackedWorkspaceArchive(directory: string): Promise<Buffer> {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: directory,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const chunks: Buffer[] = [];
  const archive = createTar({ cwd: directory, portable: true, noMtime: true }, tracked);
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function candidateAppId(files: Awaited<ReturnType<typeof readSource>>): string {
  const contract = files.find((file) => file.path === "app.contract.json");
  if (contract)
    try {
      const parsed = JSON.parse(contract.content) as { appId?: unknown };
      if (typeof parsed.appId === "string" && /^[a-z][a-z0-9-]*$/u.test(parsed.appId))
        return parsed.appId;
    } catch {
      /* Runtime readiness reports malformed candidate metadata as a failure. */
    }
  return "/";
}

async function artifactFile(name: string, content: string) {
  const path = join(output, name);
  await writeFile(`${path}.partial`, content, { mode: 0o600 });
  await rename(`${path}.partial`, path);
}

function escape(value: string) {
  return value.replaceAll(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
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

function requirementRow(requirement: Assessment["rows"][number]) {
  return `<tr><td>${escape(requirement.status)}</td><th>${escape(requirement.side)}</th><td>${escape(requirement.requirementId)}</td><td>${escape(requirement.reason)}</td><td>${escape(requirement.artifacts.join(" "))}</td></tr>`;
}

function reportHtml(report: {
  createdAt: string;
  generation: Record<string, unknown>;
  requirements: Assessment["rows"];
  gaps: Record<string, unknown>[];
  captures: { label: string; files: string[]; status: string }[];
}) {
  const rows = report.requirements.map(requirementRow).join("");
  const gaps = report.gaps.length
    ? `<ol>${report.gaps.map((gap) => `<li><strong>${escape(String(gap.priority).toUpperCase())}: ${escape(String(gap.title))}</strong><p>${escape(String(gap.expected))}</p><p>${escape(String(gap.recommendation))}</p><small>${escape(String(gap.confirmed ? "Confirmed source gap" : "Blocked; cause not established"))}</small></li>`).join("")}</ol>`
    : "<p>No failed or blocked requirements were recorded.</p>";
  const diagnosticPairs = desktopViewports
    .map(({ name }) => {
      const reference = report.captures
        .find((item) => item.label === "reference")
        ?.files.find((file) => file.endsWith(`/${name}.png`));
      const candidate = report.captures
        .find((item) => item.label === "candidate diagnostic routes")
        ?.files.find((file) => file.endsWith(`/${name}/root.png`));
      if (!reference || !candidate) return "";
      return `<section><h3>${escape(name)} initial routes</h3><p>Diagnostic comparison; equivalent workflow states have not been established.</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><figure><figcaption>Reference</figcaption><img style="width:100%" src="${escape(reference)}" alt="Reference initial route"></figure><figure><figcaption>Candidate</figcaption><img style="width:100%" src="${escape(candidate)}" alt="Candidate initial route"></figure></div></section>`;
    })
    .join("");
  const captureItems = report.captures
    .map(
      (item) =>
        `<li><strong>${escape(item.label)}</strong>: ${escape(item.status)}${item.files.length ? ` — ${item.files.map((file) => `<a href="${escape(file)}">${escape(basename(file))}</a>${/\.(?:png|jpe?g|webp)$/iu.test(file) ? `<img src="${escape(file)}" alt="${escape(item.label)} ${escape(basename(file))}" style="display:block;max-width:100%;margin:12px 0">` : ""}`).join(", ")}` : ""}</li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App Builder self-reproduction eval</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 24px;max-width:1280px;color:#202124}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}td:first-child{text-transform:uppercase;font-weight:700}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}li{margin:14px 0}</style><main><h1>App Builder self-reproduction eval</h1><p>One unassisted baseline. Static evidence does not prove runtime behavior. Missing or unavailable evidence is never reported as success.</p><p>${escape(report.createdAt)} · <a href="report.json">JSON evidence</a> · <a href="report.md">Markdown summary</a></p><h2>Generation</h2><pre>${escape(JSON.stringify(report.generation, null, 2))}</pre><h2>Prioritized gaps</h2>${gaps}<h2>Requirements</h2><table><thead><tr><th>Status</th><th>Side</th><th>Requirement</th><th>Reason</th><th>Artifacts</th></tr></thead><tbody>${rows}</tbody></table><h2>Browser evidence</h2>${diagnosticPairs}<ul>${captureItems || "<li>Not captured.</li>"}</ul></main></html>`;
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
        process.execPath,
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
  const command = values.generator ?? resolve(root, ".config/mise/scripts/trusted-node-launcher");
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
  }>((_resolve) => {
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
      _resolve({ exitCode, signal, ...(spawnError ? { error: spawnError } : {}) });
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
    const previewFiles = await capturePreview({
      url,
      output: destination,
      tokens: {},
      scenarios: [],
      ignoreHTTPSErrors: label === "reference" && referenceFixtureRoot !== undefined,
      generatedSourcePaths: sourceRoot
        ? (await readSource(sourceRoot)).map((file) => file.path)
        : [],
    });
    return {
      label,
      files: previewFiles.map((item) => `captures/${label}/${basename(item.path)}`),
      status: "captured",
    };
  } catch (error) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await writeFile(
      join(destination, "capture-error.json"),
      JSON.stringify(
        sanitizeEvidence({
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
        null,
        2,
      ),
      { mode: 0o600 },
    );
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

function runtimeObservations(existingRequirementIds: ReadonlySet<string>): Observation[] {
  if (candidateRuntime.status === "not-run") return [];
  if (candidateRuntime.status !== "available")
    return candidateRuntimeFailureObservations({
      receipt: candidateRuntime,
      existingRequirementIds,
    });
  // Readiness and a guessed /docs route are diagnostics, not workflow evidence.
  // Only the evaluator adapter that activates the actual controls can assess docs.
  return workflowMatrix
    .filter((row) => row.id !== "anonymous-entry" && !existingRequirementIds.has(row.id))
    .map((row): Observation => ({
      requirementId: row.id,
      disposition: "not-run",
      reason:
        "Candidate runtime started, but no trusted workflow adapter exists for this behavior.",
      assertions: [],
      artifacts: ["candidate-runtime.json"],
      method: "none",
    }));
}

async function saveReport() {
  const diagnosticRequirements = [
    ...buildRequirements(candidateFiles, workflowEvidence),
    ...(referenceFiles
      ? frameworkRequirements(auditFramework(referenceFiles), "reference")
      : blockedFramework("reference")),
    ...(candidateFiles
      ? frameworkRequirements(auditFramework(candidateFiles), "candidate")
      : blockedFramework("candidate")),
  ];
  const candidateOutput = candidate.status === "available" ? "available" : "missing";
  const runtimeReceipts = mergeRuntimeEvidence({
    trustedReceipts: [
      ...sandboxWorkflowReceipts,
      ...referenceNavigationReceipts,
      ...trustedWorkflowReceipts,
      ...trustedFrameworkReceipts,
    ],
    candidateFallback: runtimeObservations(new Set()),
  });
  const completedCaptures = pairedCaptures;
  const observedCaptureReceipts =
    completedCaptures?.manifest.rows.flatMap((row) =>
      (["reference", "candidate"] as const).flatMap((side) => {
        const observation = completedCaptures.observations[side].find(
          (item) => item.requirementId === row.requirementId,
        );
        return observation
          ? [{ side, viewport: row.viewport, state: row.state, ...observation }]
          : [];
      }),
    ) ?? [];
  for (const observation of sandboxCaptureObservations) {
    if (
      observedCaptureReceipts.some(
        (row) => row.side === "candidate" && row.requirementId === observation.requirementId,
      )
    )
      continue;
    const [, viewportName, stateName] = observation.requirementId.split("/");
    const viewport = desktopViewports.find((item) => item.name === viewportName);
    const state = captureStates.find((item) => item === stateName);
    if (viewport && state)
      observedCaptureReceipts.push({ side: "candidate", viewport, state, ...observation });
  }
  const observedCandidateCaptureIds = new Set(
    observedCaptureReceipts
      .filter((receipt) => receipt.side === "candidate")
      .map((receipt) => receipt.requirementId),
  );
  const failedRuntimeCaptureReceipts = candidateRuntimeCaptureFailureObservations({
    receipt: candidateRuntime,
    existingRequirementIds: observedCandidateCaptureIds,
  }).map((observation) => {
    const [, viewportName, stateName] = observation.requirementId.split("/");
    const viewport = desktopViewports.find((item) => item.name === viewportName);
    const state = captureStates.find((item) => item === stateName);
    if (!viewport || !state)
      throw new Error(
        `Invalid candidate runtime capture requirement ${observation.requirementId}.`,
      );
    return { side: "candidate" as const, viewport, state, ...observation };
  });
  const captureReceipts = [...observedCaptureReceipts, ...failedRuntimeCaptureReceipts];
  const parityEvidence: ParityEvidence = parityEvidenceFromReceipts({
    runId: basename(output),
    reference: {
      output: referenceFiles ? "available" : "missing",
      reason: referenceFiles
        ? "Reference source is available; behavioral parity observations have not run."
        : "Reference source is unavailable.",
      sourceRevision: String(
        (revisions.builder as { commit?: unknown } | undefined)?.commit ?? "unavailable",
      ),
    },
    candidate: {
      output: candidateOutput,
      reason:
        candidateOutput === "available"
          ? "Candidate source is available; behavioral parity observations have not run."
          : String(candidate.reason ?? "Candidate output is unavailable."),
      sourceRevision: String(
        (candidate.revision as { commit?: unknown } | undefined)?.commit ?? "generated-export",
      ),
    },
    runtimeReceipts,
    captureReceipts,
  });
  await jsonFile("parity-evidence.json", parityEvidence);
  parityAssessment = await assessParity(parityEvidence, async (path) => {
    try {
      const info = await stat(join(output, path));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  });
  await jsonFile("parity-assessment.json", parityAssessment);
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
    candidateRuntime,
    errors,
  };
  const report = {
    ...receipt,
    reference: referenceFiles
      ? { framework: auditFramework(referenceFiles), sourceFiles: referenceFiles.length }
      : { status: "unavailable" },
    requirements: parityAssessment.rows,
    diagnostics: {
      sourceScans: diagnosticRequirements,
      sourceScanGaps: prioritizedGaps(diagnosticRequirements),
      note: "Source scans are diagnostic only and never award parity credit.",
    },
    gaps: parityAssessment.rows
      .filter((row) => row.status !== "passed")
      .map((row) => ({
        priority: row.status === "failed" ? "high" : "medium",
        title: `${row.side}: ${row.requirementId}`,
        expected: "Evaluator-owned behavioral evidence for every required assertion.",
        recommendation: row.reason,
        confirmed: row.status === "failed",
      })),
    captures: captures.length
      ? captures
      : [
          { label: "reference", files: [], status: "unassessed: capture has not run" },
          { label: "candidate", files: [], status: "unassessed: capture has not run" },
        ],
    pairedCaptureManifest: pairedCaptures ? "parity/captures/manifest.json" : undefined,
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
  [--reference-url URL] [--candidate-url URL] [--capture-adapter evals/PATH] [--generation-timeout-ms N]
  [--candidate-runtime] [--debug-prerender] [--reference-runtime]
  [--workflow-adapter-module EVALUATOR_MODULE]
  [--report-only --candidate-root PATH]

Explicitly runs the native live Eve benchmark with strict assertions and writes
sanitized evidence outside the source tree. No publication or deployment.
--report-only audits an existing candidate without running generation.
--reference-runtime starts an isolated emulated reference; live native runs do this by default.
--candidate-runtime starts the exported candidate in an evaluator-owned Vercel Sandbox
and retains build, readiness, and public documentation probe receipts.
--debug-prerender retains an additional diagnostic build after production build failure;
it never substitutes for production acceptance.
--capture-adapter loads an evaluator-owned module under evals/ and executes the
complete paired desktop state matrix against both supplied URLs.
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
  await jsonFile("candidate-runtime.json", candidateRuntime);
  await jsonFile("trusted-workflow-receipts.json", trustedWorkflowReceipts);
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
    const providedCheckout = values["arrusted-root"] ?? process.env.SELF_REPRODUCTION_ARRUSTED_ROOT;
    const templateSource =
      providedCheckout ||
      values["candidate-runtime"] ||
      (!values["report-only"] && !values.generator)
        ? await prepareSelfReproductionTemplateSource({
            outputDirectory: output,
            providedCheckout,
          })
        : undefined;
    const arrustedRoot = templateSource?.sourcePath;
    revisions = {
      builder: revision(root),
      arrusted: {
        ...revision(arrustedRoot),
        ...(templateSource ? { acquisition: templateSource } : {}),
      },
    };
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
        candidateFiles = await readCandidateSource(candidateRoot);
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
    } else {
      const exported = candidateExportFromEvidence(records);
      if (exported) {
        candidateFiles = exported;
        for (const file of exported) {
          const destination = join(output, "candidate", file.path);
          await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
          await writeFile(destination, file.content, { mode: 0o600 });
        }
        candidate = {
          status: "available",
          provenance: candidateExportProvenanceFromEvidence(records),
          files: exported.map((file) => ({
            path: `candidate/${file.path}`,
            sha256: digest(file.content),
          })),
        };
      } else
        candidate = {
          status: "unavailable",
          reason:
            "The native run did not retain a valid reviewed candidate export. Framework and workflow comparison remain blocked.",
        };
    }
    await saveReport();
    if (
      values["reference-runtime"] ||
      (!values["report-only"] && !values.generator && !values["reference-url"])
    ) {
      if (!values["mise-executable"])
        throw new Error("Reference startup requires the mise-owned eval entrypoint.");
      const reference = await startSelfReproductionReferenceRuntime({
        sourceRoot: root,
        runtimeRoot: join(output, "reference-runtime"),
        miseExecutable: values["mise-executable"],
      });
      stopReference = reference.stop;
      await jsonFile("reference-runtime.json", reference.receipt);
      if (reference.receipt.status === "available") {
        values["reference-url"] = reference.receipt.referenceUrl;
        referenceFixtureRoot = reference.receipt.fixtureRoot;
        referenceDatabaseUrl = reference.receipt.databaseUrl;
        Object.assign(process.env, reference.receipt.environment);
      }
    }
    if (values["candidate-runtime"] || (!values["report-only"] && !values.generator)) {
      const credentials = loadProjectOidc();
      const { evaluateCandidateRuntime } =
        await import("../evals/support/self-reproduction-runtime");
      const workspaceArchive = arrustedRoot
        ? await trackedWorkspaceArchive(arrustedRoot)
        : undefined;
      candidateRuntime =
        candidateFiles && workspaceArchive
          ? await evaluateCandidateRuntime({
              files: candidateFiles.map((file) => ({ path: file.path, content: file.content })),
              workspaceArchive,
              candidateAppId: candidateAppId(candidateFiles),
              publicBasePath: `/${candidateAppId(candidateFiles)}`,
              credentials,
              appRoot: "/workspace",
              debugPrerender: values["debug-prerender"],
              onReady: async ({ session, baseURL, abortSignal }) => {
                const comparison = await runSandboxRuntimeComparison({
                  session,
                  ...sandboxBrowserComparison(),
                  payload: { baseURL },
                  abortSignal,
                });
                const { artifacts, ...receipt } = comparison;
                await jsonFile("candidate-browser-comparison.json", {
                  ...receipt,
                  artifacts: artifacts.map(({ path }) => `candidate-browser/${path}`),
                });
                for (const artifact of artifacts) {
                  const target = join(output, "candidate-browser", artifact.path);
                  await mkdir(resolve(target, ".."), { recursive: true });
                  await writeFile(target, artifact.content, { mode: 0o600 });
                }
                captures.push({
                  label: "candidate diagnostic routes",
                  files: artifacts.map(({ path }) => `candidate-browser/${path}`),
                  status: `${comparison.status}; unseeded captures do not establish workflow-state parity`,
                });
                const workflows = await runSandboxRuntimeComparison({
                  session,
                  ...sandboxCandidateWorkflowComparison(),
                  payload: { baseURL },
                  abortSignal,
                });
                const { artifacts: workflowArtifacts, ...workflowReceipt } = workflows;
                await jsonFile("candidate-browser-workflows.json", {
                  ...workflowReceipt,
                  artifacts: workflowArtifacts.map(({ path }) => path),
                });
                const observations = workflows.output as {
                  outcomes?: CandidateWorkflowOutcome[];
                } | null;
                if (Array.isArray(observations?.outcomes)) {
                  sandboxWorkflowReceipts = candidateWorkflowReceipts(
                    observations.outcomes,
                    "candidate-browser-workflows.json",
                  );
                  await jsonFile("candidate-workflow-receipts.json", sandboxWorkflowReceipts);
                }
                const interactions = await runSandboxRuntimeComparison({
                  session,
                  ...sandboxCandidateInteractionCaptures(),
                  payload: { baseURL },
                  abortSignal,
                });
                const { artifacts: interactionArtifacts, ...interactionReceipt } = interactions;
                await jsonFile("candidate-interactions.json", {
                  ...interactionReceipt,
                  artifacts: interactionArtifacts.map(
                    ({ path }) => `candidate-interactions/${path}`,
                  ),
                });
                for (const artifact of interactionArtifacts) {
                  const target = join(output, "candidate-interactions", artifact.path);
                  await mkdir(resolve(target, ".."), { recursive: true });
                  await writeFile(target, artifact.content, { mode: 0o600 });
                }
                const captured = interactions.output as { observations?: Observation[] } | null;
                if (Array.isArray(captured?.observations)) {
                  sandboxCaptureObservations = captured.observations.map((observation) => ({
                    ...observation,
                    artifacts: [
                      "candidate-interactions.json",
                      ...observation.artifacts.map((path) => `candidate-interactions/${path}`),
                    ],
                    assertions: observation.assertions.map((assertion) => ({
                      ...assertion,
                      artifacts: [
                        "candidate-interactions.json",
                        ...observation.artifacts.map((path) => `candidate-interactions/${path}`),
                      ],
                    })),
                  }));
                }
                captures.push({
                  label: "candidate desktop interactions",
                  files: interactionArtifacts.map(({ path }) => `candidate-interactions/${path}`),
                  status: `${interactions.status}; state coverage is recorded per assertion`,
                });
              },
            })
          : {
              status: "failed",
              reason:
                candidateFiles === undefined
                  ? "Candidate output was unavailable, so its runtime could not start."
                  : "The Arrusted workspace source was unavailable, so workspace dependencies could not be resolved.",
            };
      await jsonFile("candidate-runtime.json", candidateRuntime);
    }
    captures.push(
      ...(await Promise.all([
        capture("reference", values["reference-url"], root),
        capture("candidate", values["candidate-url"], candidateRoot),
      ])),
    );
    try {
      await runConfiguredWorkflowAdapters(candidateRoot);
    } catch (error) {
      errors.push(
        `Trusted workflow adapter failed: ${String(
          sanitizeEvidence(error instanceof Error ? error.message : String(error)),
        )}`,
      );
      await jsonFile("trusted-workflow-receipts.json", trustedWorkflowReceipts);
    }
    if (values["reference-navigation-evidence"]) {
      const directory = resolve(values["reference-navigation-evidence"]);
      // Reuse evaluator evidence without rerunning production builds. Preserve its own provenance.
      for (const file of ["run.json", "navigation.spec.ts", "playwright.json", "receipt.json"]) {
        await mkdir(join(output, "reference-navigation"), { recursive: true });
        await cp(join(directory, file), join(output, "reference-navigation", file));
      }
      const receipt = runtimeReceiptSchema.parse(
        JSON.parse(await readFile(join(output, "reference-navigation/receipt.json"), "utf-8")),
      );
      if (
        receipt.side !== "reference" ||
        receipt.observation.requirementId !== "instant-navigation"
      )
        throw new Error("Expected reference instant-navigation evaluator evidence.");
      referenceNavigationReceipts = [receipt];
    } else if (values["reference-navigation"] || (!values["report-only"] && !values.generator)) {
      if (!values["mise-executable"])
        throw new Error("Reference navigation requires the mise-owned eval entrypoint.");
      const { runReferenceNavigationEvidence } =
        await import("../evals/support/self-reproduction-reference-navigation");
      const receipt = await runReferenceNavigationEvidence({
        repositoryRoot: root,
        outputRoot: output,
        miseExecutable: values["mise-executable"],
      });
      referenceNavigationReceipts = [receipt];
      await jsonFile("reference-navigation/receipt.json", receipt);
    }
    await saveReport();
    await runConfiguredPairedCaptures();
    if (referenceDatabaseUrl) {
      const { runReferenceLifecycle } =
        await import("../evals/support/self-reproduction-reference-lifecycle");
      await runReferenceLifecycle({
        databaseUrl: referenceDatabaseUrl,
        outputRoot: join(output, "reference-service-diagnostics"),
      });
    }
  } catch (error) {
    errors.push(String(sanitizeEvidence(error instanceof Error ? error.message : String(error))));
    if (generation.status === "pending" || generation.status === "running")
      generation = { ...generation, status: "failed" };
  } finally {
    try {
      await saveReport();
    } finally {
      await stopReference?.();
    }
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
