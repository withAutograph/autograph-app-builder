import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { HOSTED_ARTIFACT_URL } from "./hosted-artifact";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("hosted runtime asset bundle", () => {
  it("loads managed seeds and immutable artifact identity without authored bytes", () => {
    const runtimeRoot = mkdtempSync(path.join(tmpdir(), "hosted-runtime-assets-"));
    temporaryRoots.push(runtimeRoot);
    const seedsModule = pathToFileURL(path.resolve("lib/sandbox/hosted-managed-seeds.ts")).href;
    const artifactModule = pathToFileURL(path.resolve("lib/sandbox/hosted-artifact.ts")).href;
    const tsxLoader = import.meta.resolve("tsx/esm");
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_OPTIONS;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        "--input-type=module",
        "--eval",
        `const [seeds, artifact] = await Promise.all([import(${JSON.stringify(seedsModule)}), import(${JSON.stringify(artifactModule)})]);
process.stdout.write(JSON.stringify({ artifactUrl: artifact.HOSTED_ARTIFACT_URL, files: seeds.readHostedManagedSeedFiles().map(file => ({path: file.path, bytes: file.content.length})) }));`,
      ],
      {
        cwd: runtimeRoot,
        encoding: "utf-8",
        env: childEnvironment,
      },
    );

    expect(JSON.parse(output)).toHaveProperty("artifactUrl", HOSTED_ARTIFACT_URL);
    expect(JSON.parse(output)).toHaveProperty(
      "files",
      expect.arrayContaining([
        expect.objectContaining({ path: "$HOME/.agents/skills/create-app/SKILL.md" }),
      ]),
    );
  });
});

it("packages edited and additional skill files for source-free runtime transfer", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hosted-skill-packaging-"));
  temporaryRoots.push(root);
  const skills = path.join(root, "agent/skills");
  const output = path.join(root, "lib/sandbox");
  mkdirSync(path.join(skills, "create-app"), { recursive: true });
  mkdirSync(output, { recursive: true });
  const loader = path.join(output, "hosted-managed-seeds.ts");
  writeFileSync(loader, readFileSync("lib/sandbox/hosted-managed-seeds.ts"));
  const authored = path.join(skills, "create-app/SKILL.md");
  writeFileSync(authored, "Initial synthetic instruction.");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_OPTIONS;
  const generate = () =>
    execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        path.resolve(".config/mise/scripts/repository/generate-hosted-runtime-assets.mts"),
      ],
      { cwd: root, env: childEnvironment },
    );
  generate();
  writeFileSync(authored, "Updated synthetic instruction.");
  mkdirSync(path.join(skills, "additional/references"), { recursive: true });
  writeFileSync(
    path.join(skills, "additional/references/new.md"),
    "Additional synthetic reference.",
  );
  generate();
  rmSync(path.join(root, "agent"), { recursive: true });
  const loaded = execFileSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx/esm"),
      "--input-type=module",
      "--eval",
      `const {readHostedManagedSeedFiles} = await import(${JSON.stringify(pathToFileURL(loader).href)});
process.stdout.write(JSON.stringify(readHostedManagedSeedFiles().map(file => ({path:file.path,content:file.content.toString("utf-8")}))));`,
    ],
    { cwd: root, env: childEnvironment, encoding: "utf-8" },
  );
  expect(JSON.parse(loaded)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "$HOME/.agents/skills/create-app/SKILL.md",
        content: "Updated synthetic instruction.",
      }),
      expect.objectContaining({
        path: "$HOME/.agents/skills/additional/references/new.md",
        content: "Additional synthetic reference.",
      }),
    ]),
  );
});
