import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

import type { SandboxSeedFile } from "eve/sandbox";

export const HOSTED_MANAGED_SKILLS_SOURCE = "agent/skills";
export const HOSTED_MANAGED_SKILLS_TARGET = "$HOME/.agents/skills";

function listRegularFiles(input: {
  readonly directory: string;
  readonly relativeDirectory: string;
}): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(input.directory, { withFileTypes: true })) {
    const relativePath = posix.join(input.relativeDirectory, entry.name);
    const absolutePath = join(input.directory, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...listRegularFiles({
          directory: absolutePath,
          relativeDirectory: relativePath,
        }),
      );
      continue;
    }
    if (!entry.isFile())
      throw new Error(
        `The hosted managed seed source contains an unsupported entry: ${relativePath}`,
      );
    files.push(relativePath);
  }
  return files;
}

/**
 * Reconstructs Eve's current managed skill seed set for runtime template
 * recovery. The source directory is explicitly included in Next.js output
 * tracing, and only regular files are accepted.
 */
export function readHostedManagedSeedFiles(
  repositoryRoot = process.cwd(),
): readonly SandboxSeedFile[] {
  const sourceRoot = resolve(repositoryRoot, HOSTED_MANAGED_SKILLS_SOURCE);
  const relativePaths = listRegularFiles({
    directory: sourceRoot,
    relativeDirectory: ".",
  }).sort((left, right) => left.localeCompare(right));
  if (relativePaths.length === 0)
    throw new Error("The hosted managed skill seed set is empty.");

  return relativePaths.map((relativePath) => ({
    content: readFileSync(join(sourceRoot, relativePath)),
    path: posix.join(HOSTED_MANAGED_SKILLS_TARGET, relativePath),
  }));
}
