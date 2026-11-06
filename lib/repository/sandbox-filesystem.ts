import type { SandboxSession } from "eve/sandbox";

const DIRECTORY_BATCH_SIZE = 256;

const directoryFailureDetail = (value: string): string =>
  value
    .replaceAll(/https?:\/\/[^\s]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?<key>authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$<key>=[REDACTED]",
    )
    .replaceAll(/\s+/gu, " ")
    .trim();

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function quoteSandboxArgument(value: string): string {
  const singleQuote = String.fromCodePoint(39);
  const escapedQuote = `${singleQuote}"${singleQuote}"${singleQuote}`;
  return `${singleQuote}${value.replaceAll(singleQuote, escapedQuote)}${singleQuote}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function ensureSandboxDirectories(
  sandbox: SandboxSession,
  paths: readonly string[],
): Promise<void> {
  const directories = [...new Set(paths)].toSorted();
  for (let index = 0; index < directories.length; index += DIRECTORY_BATCH_SIZE) {
    const batch = directories.slice(index, index + DIRECTORY_BATCH_SIZE);
    let result: Awaited<ReturnType<SandboxSession["run"]>>;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- prepare each directory batch in order.
      result = await sandbox.run({
        command: `mkdir -p ${batch.map(quoteSandboxArgument).join(" ")}`,
        workingDirectory: "/workspace",
      });
    } catch (error) {
      throw new Error(
        `Builder could not create ${batch.length} workspace directory paths in the sandbox. Check sandbox availability, write permissions, and free space, then retry. Cause: ${directoryFailureDetail(error instanceof Error ? error.message : String(error)) || "The sandbox provider returned no diagnostic output."}`,
        { cause: error },
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Builder could not create ${batch.length} workspace directory paths (exit ${result.exitCode}). Check write permissions and free space under /workspace, then retry. Cause: ${directoryFailureDetail(result.stderr || result.stdout) || "mkdir returned no diagnostic output."}`,
      );
    }
  }
}
