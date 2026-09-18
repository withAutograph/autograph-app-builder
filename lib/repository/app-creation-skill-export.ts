import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { runSequentially } from "../async-sequential";

export const APP_CREATION_SKILL_ROOTS = [
  "arrusted-next-app-like-experience",
  "create-app",
  "design-app",
  "next-cache-components-adoption",
  "next-cache-components-optimizer",
  "next-dev-loop",
  "next-partial-prefetching-adoption",
  "scaffold-app-workspace",
] as const;

export const APP_CREATION_SKILL_EXPORT_DEPENDENCY_PATHS = [
  ".config/mise/config.toml",
  ".config/mise/mise.lock",
  ".config/mise/scripts/trusted-node-launcher",
  ".config/mise/tasks/skills/export",
  "agent/vercel-next-workflows.lock.json",
  "lib/repository/app-creation-skill-export.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/export-app-creation-skills.mts",
  "tsconfig.json",
] as const;

interface ExportedSkillFile {
  path: string;
  mode: "100644" | "100755";
  sha256: string;
}

export interface AppCreationSkillExportManifest {
  version: 1;
  roots: typeof APP_CREATION_SKILL_ROOTS;
  fileCount: number;
  files: ExportedSkillFile[];
  digest: string;
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function absent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function collectSkillFiles(sourceRoot: string): Promise<ExportedSkillFile[]> {
  const files: ExportedSkillFile[] = [];
  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await runSequentially(
      entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      async (entry) => {
        const filePath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error("App-creation skill exports do not accept symbolic links.");
        }
        if (entry.isDirectory()) {
          await visit(filePath);
        } else if (entry.isFile()) {
          const stats = await lstat(filePath);
          const mode = stats.mode % 0o1000;
          if (mode !== 0o644 && mode !== 0o755) {
            throw new Error(`Unsupported app-creation skill mode: ${mode.toString(8)}`);
          }
          files.push({
            mode: mode === 0o755 ? "100755" : "100644",
            path: path.relative(sourceRoot, filePath).split("\\").join("/"),
            sha256: sha256(await readFile(filePath)),
          });
        } else {
          throw new Error("App-creation skill exports accept only files and directories.");
        }
      },
    );
  }
  await runSequentially(APP_CREATION_SKILL_ROOTS, async (root) => {
    const directory = path.join(sourceRoot, root);
    const stats = await lstat(directory);
    if (!stats.isDirectory()) {
      throw new Error(`App-creation skill root is not a directory: ${root}`);
    }
    await visit(directory);
  });
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function exportAppCreationSkills(options: {
  repositoryRoot: string;
  outputRoot: string;
}): Promise<AppCreationSkillExportManifest> {
  const repositoryRoot = await realpath(path.resolve(options.repositoryRoot));
  const outputRoot = path.resolve(options.outputRoot);
  if (!(await absent(outputRoot))) {
    throw new Error("App-creation skill export destination must be absent.");
  }
  const parent = await realpath(path.resolve(outputRoot, ".."));
  const canonicalOutput = path.join(parent, path.basename(outputRoot));
  const sourceRoot = path.join(repositoryRoot, "agent", "skills");
  const files = await collectSkillFiles(sourceRoot);
  await mkdir(canonicalOutput, { mode: 0o700 });
  await runSequentially(files, async (file) => {
    const source = path.join(sourceRoot, file.path);
    const destination = path.join(canonicalOutput, file.path);
    await mkdir(path.resolve(destination, ".."), { mode: 0o755, recursive: true });
    await writeFile(destination, await readFile(source), {
      mode: file.mode === "100755" ? 0o755 : 0o644,
    });
    await chmod(destination, file.mode === "100755" ? 0o755 : 0o644);
  });
  const unsigned = {
    fileCount: files.length,
    files,
    roots: APP_CREATION_SKILL_ROOTS,
    version: 1 as const,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}
