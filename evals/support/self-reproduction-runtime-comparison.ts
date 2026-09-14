import { randomUUID } from "node:crypto";
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
export const runSandboxRuntimeComparison = async (input: {
  session: Pick<SandboxSession, "writeTextFile" | "run" | "readTextFile" | "readBinaryFile">;
  /** Trusted evaluator code, never generated application code. */
  script: string;
  payload: unknown;
  /** Explicit evaluator-owned artifact paths relative to the comparison directory. */
  artifactPaths?: readonly string[];
  abortSignal: AbortSignal;
}): Promise<RuntimeComparisonResult> => {
  const runtimeEnvironment = Object.entries(DEVELOPMENT_SANDBOX_ENVIRONMENT)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const directory = `.self-reproduction-comparison/${randomUUID()}`;
  const artifactPaths = input.artifactPaths ?? [];
  for (const path of artifactPaths) {
    if (path.startsWith("/") || path.split(/[\\/]/u).some((part) => part === ".." || part === "")) {
      throw new Error(`Comparison artifact must be a relative child path: ${path}`);
    }
  }
  const result: RuntimeComparisonResult = {
    artifacts: [],
    command: { exitCode: null, stderr: "", stdout: "" },
    errors: [],
    output: null,
    reason: "Evaluator comparison did not complete.",
    status: "failed",
  };
  try {
    await input.session.writeTextFile({ content: input.script, path: `${directory}/runner.mjs` });
    await input.session.writeTextFile({
      content: JSON.stringify(input.payload),
      path: `${directory}/input.json`,
    });
    const command = await input.session.run({
      abortSignal: input.abortSignal,
      command: `${runtimeEnvironment} node ${directory}/runner.mjs ${directory}/input.json ${directory}/output.json`,
    });
    result.command = { exitCode: command.exitCode, stderr: command.stderr, stdout: command.stdout };
    if (command.exitCode !== 0) {
      result.errors.push(`Evaluator exited with code ${command.exitCode}.`);
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  // Recover partial output even after an evaluator exception or nonzero exit.
  try {
    const output = await input.session.readTextFile({ path: `${directory}/output.json` });
    if (output === null) {
      throw new Error("Evaluator output file is missing.");
    }
    result.output = JSON.parse(output);
  } catch (error) {
    result.errors.push(
      `Comparison output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const path of artifactPaths) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve partial artifacts individually
      const content = await input.session.readBinaryFile({ path: `${directory}/${path}` });
      if (content === null) {
        throw new Error("Evaluator artifact file is missing.");
      }
      result.artifacts.push({ content, path });
    } catch (error) {
      result.errors.push(
        `Artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  result.status = result.errors.length === 0 ? "completed" : "failed";
  result.reason =
    result.status === "completed"
      ? "Evaluator comparison completed in the live sandbox."
      : result.errors.join(" ");
  return result;
};
