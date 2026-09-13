import type { SandboxSession } from "eve/sandbox";
import { DEVELOPMENT_SANDBOX_ENVIRONMENT } from "../../lib/sandbox/development-toolchain";

export interface RuntimeComparisonResult {
  status: "completed" | "failed";
  reason: string;
  command: { exitCode: number | null; stdout: string; stderr: string };
  output: unknown;
  artifacts: { path: string; content: Uint8Array }[];
  errors: string[];
}

/** Runs evaluator code against loopback while the caller retains the live sandbox. */
export async function runSandboxRuntimeComparison(input: {
  session: Pick<SandboxSession, "writeTextFile" | "run" | "readTextFile" | "readBinaryFile">;
  /** Trusted evaluator code, never generated application code. */
  script: string;
  payload: unknown;
  /** Explicit evaluator-owned artifact paths relative to the comparison directory. */
  artifactPaths?: readonly string[];
  abortSignal: AbortSignal;
}): Promise<RuntimeComparisonResult> {
  const runtimeEnvironment = Object.entries(DEVELOPMENT_SANDBOX_ENVIRONMENT)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const directory = ".self-reproduction-comparison";
  const artifactPaths = input.artifactPaths ?? [];
  for (const path of artifactPaths)
    if (path.startsWith("/") || path.split(/[\\/]/u).some((part) => part === ".." || part === ""))
      throw new Error(`Comparison artifact must be a relative child path: ${path}`);
  const result: RuntimeComparisonResult = {
    status: "failed",
    reason: "Evaluator comparison did not complete.",
    command: { exitCode: null, stdout: "", stderr: "" },
    output: null,
    artifacts: [],
    errors: [],
  };
  try {
    await input.session.writeTextFile({ path: `${directory}/runner.mjs`, content: input.script });
    await input.session.writeTextFile({
      path: `${directory}/input.json`,
      content: JSON.stringify(input.payload),
    });
    const command = await input.session.run({
      command: `${runtimeEnvironment} node ${directory}/runner.mjs ${directory}/input.json ${directory}/output.json`,
      abortSignal: input.abortSignal,
    });
    result.command = { exitCode: command.exitCode, stdout: command.stdout, stderr: command.stderr };
    if (command.exitCode !== 0)
      result.errors.push(`Evaluator exited with code ${command.exitCode}.`);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  // Recover partial output even after an evaluator exception or nonzero exit.
  try {
    const output = await input.session.readTextFile({ path: `${directory}/output.json` });
    if (output === null) throw new Error("Evaluator output file is missing.");
    result.output = JSON.parse(output);
  } catch (error) {
    result.errors.push(
      `Comparison output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const path of artifactPaths)
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve partial artifacts individually
      const content = await input.session.readBinaryFile({ path: `${directory}/${path}` });
      if (content === null) throw new Error("Evaluator artifact file is missing.");
      result.artifacts.push({ path, content });
    } catch (error) {
      result.errors.push(
        `Artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  result.status = result.errors.length === 0 ? "completed" : "failed";
  result.reason =
    result.status === "completed"
      ? "Evaluator comparison completed in the live sandbox."
      : result.errors.join(" ");
  return result;
}
