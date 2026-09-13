import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Observation } from "./self-reproduction-parity";

const execute = promisify(execFile);
const directTitle =
  "/auth/sign-in?callbackURL=%2F streams its meaningful production shell and resolves";
const clientTitle = "real Sign In Link uses a prefetched production destination";
interface TestResult {
  status?: string;
  errors?: unknown[];
}
interface Suite {
  file?: string;
  suites?: Suite[];
  specs?: { title: string; tests?: { results?: TestResult[] }[] }[];
}

/** Only the two exact production tests covering all three navigation assertions earn credit. */
export function referenceNavigationObservation(input: {
  report: { suites?: Suite[] };
  artifacts: string[];
}): Observation {
  const results = new Map<string, TestResult[]>();
  const visit = (suite: Suite, file = "") => {
    const source = suite.file ?? file;
    if (
      source === "navigation.spec.ts" ||
      source.endsWith("production-navigation/navigation.spec.ts")
    )
      for (const spec of suite.specs ?? [])
        results.set(spec.title, spec.tests?.flatMap((test) => test.results ?? []) ?? []);
    for (const child of suite.suites ?? []) visit(child, source);
  };
  for (const suite of input.report.suites ?? []) visit(suite);
  const completed = (title: string) =>
    results
      .get(title)
      ?.some((result) => ["passed", "failed", "timedOut"].includes(result.status ?? "")) === true;
  const passed = (title: string) => {
    const attempts = results.get(title) ?? [];
    return attempts.length > 0 && attempts.every((result) => result.status === "passed");
  };
  const ready = completed(directTitle) && completed(clientTitle);
  return {
    requirementId: "instant-navigation",
    disposition: ready ? "observed" : "not-run",
    reason: ready
      ? "Exact reference production tests exercised direct shell, prefetched Link, and resolved controls with @next/playwright."
      : "Exact production navigation cases are missing or did not execute; aggregate test counts provide no credit.",
    method: ready ? "@next/playwright/instant" : "none",
    artifacts: input.artifacts,
    assertions: ready
      ? [
          {
            id: "instant-direct-load",
            passed: passed(directTitle),
            detail: directTitle,
            artifacts: input.artifacts,
          },
          {
            id: "instant-client-navigation",
            passed: passed(clientTitle),
            detail: clientTitle,
            artifacts: input.artifacts,
          },
          {
            id: "resolved-content-visible",
            passed: passed(directTitle) && passed(clientTitle),
            detail:
              "Both exact tests assert enabled GitHub controls after instant() releases pending content.",
            artifacts: input.artifacts,
          },
        ]
      : [],
  };
}

/** Opt-in execution uses the existing isolated production test lifecycle and JSON reporter. */
export async function runReferenceNavigationEvidence(input: {
  repositoryRoot: string;
  outputRoot: string;
  miseExecutable: string;
  databaseBackend?: "docker" | "process";
}) {
  const directory = resolve(input.outputRoot, "reference-navigation");
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, "playwright.json");
  const sourcePath = "e2e/production-navigation/navigation.spec.ts";
  const source = await readFile(join(input.repositoryRoot, sourcePath), "utf-8");
  const revision = await execute("git", ["rev-parse", "HEAD"], { cwd: input.repositoryRoot });
  const changes = await execute("git", ["status", "--porcelain"], { cwd: input.repositoryRoot });
  await writeFile(join(directory, "navigation.spec.ts"), source);
  const startedAt = new Date().toISOString();
  let run: { stdout: string; stderr: string; error?: string };
  try {
    run = await execute(
      input.miseExecutable,
      [
        "run",
        "test:production-navigation",
        "--",
        "--postgres-backend",
        input.databaseBackend ?? "docker",
        "--json-report",
        reportPath,
      ],
      {
        cwd: input.repositoryRoot,
        env: { ...process.env, MISE_BIN_PATH: input.miseExecutable },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    run = {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      error: failure.message ?? String(error),
    };
  }
  await writeFile(
    join(directory, "run.json"),
    JSON.stringify(
      {
        databaseBackend: input.databaseBackend ?? "docker",
        startedAt,
        completedAt: new Date().toISOString(),
        revision: revision.stdout.trim(),
        changes: changes.stdout,
        sourcePath,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        ...run,
      },
      null,
      2,
    ),
  );
  let report = {};
  try {
    report = JSON.parse(await readFile(reportPath, "utf-8"));
  } catch {
    /* Missing reporter evidence remains unassessed. */
  }
  return {
    schemaVersion: "self-reproduction-runtime-receipt/v1" as const,
    producer: "evaluator" as const,
    side: "reference" as const,
    observation: referenceNavigationObservation({
      report,
      artifacts: [
        "reference-navigation/run.json",
        "reference-navigation/navigation.spec.ts",
        ...(Object.keys(report).length ? ["reference-navigation/playwright.json"] : []),
      ],
    }),
  };
}
