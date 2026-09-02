import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HOSTED_MANAGED_SKILLS_SOURCE,
  HOSTED_MANAGED_SKILLS_TARGET,
  readHostedManagedSeedFiles,
} from "./hosted-managed-seeds";
import { HOSTED_MANAGED_SKILL_CONTENTS } from "./hosted-managed-seeds.generated";

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

  it("keeps the closed bundle manifest aligned with every authored skill file", () => {
    const sourceRoot = join(process.cwd(), HOSTED_MANAGED_SKILLS_SOURCE);
    expect(HOSTED_MANAGED_SKILL_CONTENTS.map(({ path }) => path)).toEqual(
      listFiles(sourceRoot),
    );
  });

  it("reads embedded managed skill bytes without a runtime source tree", () => {
    const seeds = readHostedManagedSeedFiles();
    expect(seeds).toHaveLength(HOSTED_MANAGED_SKILL_CONTENTS.length);
    expect(seeds.map(({ path }) => path)).toEqual(
      HOSTED_MANAGED_SKILL_CONTENTS.map(({ path }) =>
        posix.join(HOSTED_MANAGED_SKILLS_TARGET, path),
      ),
    );
    for (const [index, source] of HOSTED_MANAGED_SKILL_CONTENTS.entries())
      expect(seeds[index]?.content).toEqual(
        Buffer.from(source.content, "utf8"),
      );
  });

  it("does not misclassify Eve service assets as Next.js route assets", () => {
    const nextConfig = readFileSync("next.config.ts", "utf8");
    expect(nextConfig).not.toContain('"./agent/skills/**/*"');
  });

  it("keeps hosted canonical-app iteration independent of local checkout paths", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const createApp = readFileSync("agent/skills/create-app/SKILL.md", "utf8");
    for (const content of [instructions, createApp]) {
      expect(content).toMatch(
        /builder-owned canonical clone as (?:a|the) `fresh-template`/u,
      );
      expect(content).toContain("local checkout path");
    }
  });

  it("requires silent exact-path repair instead of source replay or prose planning", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const createApp = readFileSync("agent/skills/create-app/SKILL.md", "utf8");
    const planApp = readFileSync(
      "agent/skills/plan-app-creation/SKILL.md",
      "utf8",
    );
    const planningTool = readFileSync(
      "agent/tools/plan_app_creation.ts",
      "utf8",
    );
    const contract = [instructions, createApp, planApp, planningTool].join(
      "\n",
    );
    expect(contract).toMatch(
      /exact(?:AppOwnedPaths| app-owned| candidate paths)/u,
    );
    expect(contract).toMatch(/do not resolve|without resolving/iu);
    expect(contract).toMatch(/prose (?:implementation outline|outline|plan)/iu);
    expect(contract).toContain("inspect_existing_app");
  });
});
