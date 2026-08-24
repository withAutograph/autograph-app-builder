import type { SandboxSession } from "eve/sandbox";

const DIRECTORY_BATCH_SIZE = 256;
const DIRECTORY_TIMEOUT_MS = 30_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export async function ensureSandboxDirectories(
  sandbox: SandboxSession,
  paths: readonly string[],
): Promise<void> {
  const directories = [...new Set(paths)].toSorted();
  for (
    let index = 0;
    index < directories.length;
    index += DIRECTORY_BATCH_SIZE
  ) {
    const batch = directories.slice(index, index + DIRECTORY_BATCH_SIZE);
    const result = await sandbox.run({
      command: `mkdir -p ${batch.map(shellQuote).join(" ")}`,
      workingDirectory: "/workspace",
      abortSignal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
    });
    if (result.exitCode !== 0)
      throw new Error(
        "The sandbox workspace directories could not be prepared.",
      );
  }
}
