import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HOSTED_MANAGED_SKILLS_SOURCE,
  HOSTED_MANAGED_SKILLS_TARGET,
  readHostedManagedSeedFiles,
} from "./hosted-managed-seeds";

const temporaryRoots: string[] = [];

function listFiles(directory: string, relativeDirectory = "."): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory())
      files.push(...listFiles(join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("hosted managed sandbox seeds", () => {
  it("replays every managed skill path and byte from the authored package", () => {
    const sourceRoot = join(process.cwd(), HOSTED_MANAGED_SKILLS_SOURCE);
    const sourceFiles = listFiles(sourceRoot);
    const seeds = readHostedManagedSeedFiles();

    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(seeds.map(({ path }) => path)).toEqual(
      sourceFiles.map((path) => posix.join(HOSTED_MANAGED_SKILLS_TARGET, path)),
    );
    for (const [index, sourcePath] of sourceFiles.entries())
      expect(seeds[index]?.content).toEqual(
        readFileSync(join(sourceRoot, sourcePath)),
      );
  });

  it("rejects unsupported entries instead of following them", () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-managed-seeds-"));
    temporaryRoots.push(root);
    const skills = join(root, HOSTED_MANAGED_SKILLS_SOURCE);
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, "SKILL.md"), "safe");
    symlinkSync(join(root, "outside"), join(skills, "linked"));

    expect(() => readHostedManagedSeedFiles(root)).toThrow(
      /unsupported entry/u,
    );
  });

  it("keeps the managed source available to every traced server route", () => {
    const nextConfig = readFileSync("next.config.ts", "utf8");
    expect(nextConfig).toContain('"./agent/skills/**/*"');
  });
});
