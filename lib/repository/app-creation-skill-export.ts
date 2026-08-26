import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

export const APP_CREATION_SKILL_ROOTS = [
  "create-app",
  "design-app",
  "plan-app-creation",
  "scaffold-app-workspace",
] as const;

export const APP_CREATION_SKILL_EXPORT_DEPENDENCY_PATHS = [
  ".config/mise/config.toml",
  ".config/mise/mise.lock",
  ".config/mise/scripts/trusted-node-launcher",
  ".config/mise/tasks/skills/export",
  "lib/repository/app-creation-skill-export.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/export-app-creation-skills.mts",
  "tsconfig.json",
] as const;

type ExportedSkillFile = {
  path: string;
  mode: "100644" | "100755";
  sha256: string;
};

export type AppCreationSkillExportManifest = {
  version: 1;
  roots: typeof APP_CREATION_SKILL_ROOTS;
  fileCount: number;
  files: ExportedSkillFile[];
  digest: string;
};

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function collectSkillFiles(
  sourceRoot: string,
): Promise<ExportedSkillFile[]> {
  const files: ExportedSkillFile[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).toSorted((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          "App-creation skill exports do not accept symbolic links.",
        );
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const mode = (await lstat(path)).mode & 0o777;
        if (mode !== 0o644 && mode !== 0o755)
          throw new Error(
            `Unsupported app-creation skill mode: ${mode.toString(8)}`,
          );
        files.push({
          path: relative(sourceRoot, path).split("\\").join("/"),
          mode: mode === 0o755 ? "100755" : "100644",
          sha256: sha256(await readFile(path)),
        });
      } else
        throw new Error(
          "App-creation skill exports accept only files and directories.",
        );
    }
  }
  for (const root of APP_CREATION_SKILL_ROOTS) {
    const directory = join(sourceRoot, root);
    if (!(await lstat(directory)).isDirectory())
      throw new Error(`App-creation skill root is not a directory: ${root}`);
    await visit(directory);
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function exportAppCreationSkills(options: {
  repositoryRoot: string;
  outputRoot: string;
}): Promise<AppCreationSkillExportManifest> {
  const repositoryRoot = await realpath(resolve(options.repositoryRoot));
  const outputRoot = resolve(options.outputRoot);
  if (!(await absent(outputRoot)))
    throw new Error("App-creation skill export destination must be absent.");
  const parent = await realpath(resolve(outputRoot, ".."));
  const canonicalOutput = join(parent, basename(outputRoot));
  const sourceRoot = join(repositoryRoot, "agent", "skills");
  const files = await collectSkillFiles(sourceRoot);
  await mkdir(canonicalOutput, { mode: 0o700 });
  for (const file of files) {
    const source = join(sourceRoot, file.path);
    const destination = join(canonicalOutput, file.path);
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o755 });
    await writeFile(destination, await readFile(source), {
      mode: file.mode === "100755" ? 0o755 : 0o644,
    });
    await chmod(destination, file.mode === "100755" ? 0o755 : 0o644);
  }
  const unsigned = {
    version: 1 as const,
    roots: APP_CREATION_SKILL_ROOTS,
    fileCount: files.length,
    files,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}
