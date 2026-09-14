import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
export const referenceNavigationObservation = (input: {
  report: { suites?: Suite[] };
  artifacts: string[];
}): Observation => {
  const results = new Map<string, TestResult[]>();
  const visit = (suite: Suite, file = "") => {
    const source = suite.file ?? file;
    if (
      source === "navigation.spec.ts" ||
      source.endsWith("production-navigation/navigation.spec.ts")
    ) {
      for (const spec of suite.specs ?? []) {
        results.set(spec.title, spec.tests?.flatMap((test) => test.results ?? []) ?? []);
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, source);
    }
  };
  for (const suite of input.report.suites ?? []) {
    visit(suite);
  }
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
    artifacts: input.artifacts,
    assertions: ready
      ? [
          {
            artifacts: input.artifacts,
            detail: directTitle,
            id: "instant-direct-load",
            passed: passed(directTitle),
          },
          {
            artifacts: input.artifacts,
            detail: clientTitle,
            id: "instant-client-navigation",
            passed: passed(clientTitle),
          },
          {
            artifacts: input.artifacts,
            detail:
              "Both exact tests assert enabled GitHub controls after instant() releases pending content.",
            id: "resolved-content-visible",
            passed: passed(directTitle) && passed(clientTitle),
          },
        ]
      : [],
    disposition: ready ? "observed" : "not-run",
    method: ready ? "@next/playwright/instant" : "none",
    reason: ready
      ? "Exact reference production tests exercised direct shell, prefetched Link, and resolved controls with @next/playwright."
      : "Exact production navigation cases are missing or did not execute; aggregate test counts provide no credit.",
    requirementId: "instant-navigation",
  };
};

/** Opt-in execution uses the existing isolated production test lifecycle and JSON reporter. */
export const runReferenceNavigationEvidence = async (input: {
  repositoryRoot: string;
  outputRoot: string;
  miseExecutable: string;
}) => {
  const directory = path.resolve(input.outputRoot, "reference-navigation");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "playwright.json");
  const sourcePath = "e2e/production-navigation/navigation.spec.ts";
  const source = await readFile(path.join(input.repositoryRoot, sourcePath), "utf-8");
  const revision = await execute("git", ["rev-parse", "HEAD"], { cwd: input.repositoryRoot });
  const changes = await execute("git", ["status", "--porcelain"], { cwd: input.repositoryRoot });
  await writeFile(path.join(directory, "navigation.spec.ts"), source);
  const startedAt = new Date().toISOString();
  let run: { stdout: string; stderr: string; error?: string };
  try {
    run = await execute(
      input.miseExecutable,
      ["run", "test:production-navigation", "--", "--json-report", reportPath],
      {
        cwd: input.repositoryRoot,
        env: { ...process.env, MISE_BIN_PATH: input.miseExecutable },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    run = {
      error: failure.message ?? String(error),
      stderr: failure.stderr ?? "",
      stdout: failure.stdout ?? "",
    };
  }
  await writeFile(
    path.join(directory, "run.json"),
    JSON.stringify(
      {
        changes: changes.stdout,
        completedAt: new Date().toISOString(),
        revision: revision.stdout.trim(),
        sourcePath,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        startedAt,
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
    observation: referenceNavigationObservation({
      artifacts: [
        "reference-navigation/run.json",
        "reference-navigation/navigation.spec.ts",
        ...(Object.keys(report).length ? ["reference-navigation/playwright.json"] : []),
      ],
      report,
    }),
    producer: "evaluator" as const,
    schemaVersion: "self-reproduction-runtime-receipt/v1" as const,
    side: "reference" as const,
  };
};
