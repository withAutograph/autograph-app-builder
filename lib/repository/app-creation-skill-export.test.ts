import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTED_MANAGED_SKILL_CONTENTS } from "../sandbox/hosted-managed-seeds.generated";

import {
  APP_CREATION_SKILL_EXPORT_DEPENDENCY_PATHS,
  APP_CREATION_SKILL_ROOTS,
  exportAppCreationSkills,
} from "./app-creation-skill-export";

describe("app-creation skill export", () => {
  it("declares its locked repository-owned execution closure", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    for (const path of APP_CREATION_SKILL_EXPORT_DEPENDENCY_PATHS)
      expect(readFileSync(join(repositoryRoot, path))).toBeInstanceOf(Buffer);
  });

  it("exports the Next app-like-experience adapter with its reviewed workflows", () => {
    expect(APP_CREATION_SKILL_ROOTS).toEqual(
      expect.arrayContaining([
        "arrusted-next-app-like-experience",
        "next-cache-components-adoption",
        "next-cache-components-optimizer",
        "next-dev-loop",
        "next-partial-prefetching-adoption",
      ]),
    );
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const lock = JSON.parse(
      readFileSync(
        join(repositoryRoot, "agent/vercel-next-workflows.lock.json"),
        "utf8",
      ),
    ) as { revision: string; skills: Record<string, string> };
    expect(lock.revision).toMatch(/^[0-9a-f]{40}$/u);
    expect(Object.keys(lock.skills).sort()).toEqual([
      "next-cache-components-adoption",
      "next-cache-components-optimizer",
      "next-dev-loop",
      "next-partial-prefetching-adoption",
    ]);
  });

  it("emits byte-identical manifests and artifacts in two independent exports", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const firstRoot = join(
      mkdtempSync(join(tmpdir(), "skill-export-a-")),
      "payload",
    );
    const secondRoot = join(
      mkdtempSync(join(tmpdir(), "skill-export-b-")),
      "payload",
    );
    const first = await exportAppCreationSkills({
      repositoryRoot,
      outputRoot: firstRoot,
    });
    const second = await exportAppCreationSkills({
      repositoryRoot,
      outputRoot: secondRoot,
    });

    expect(first).toEqual(second);
    expect(first.roots).toEqual(APP_CREATION_SKILL_ROOTS);
    expect(first.fileCount).toBeGreaterThan(0);
    for (const file of first.files)
      expect(readFileSync(join(firstRoot, file.path))).toEqual(
        readFileSync(join(secondRoot, file.path)),
      );
  });

  it("refuses to overwrite an existing destination", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const outputRoot = mkdtempSync(join(tmpdir(), "skill-export-existing-"));
    await expect(
      exportAppCreationSkills({ repositoryRoot, outputRoot }),
    ).rejects.toThrow("destination must be absent");
  });

  it.each(["interactions.md", "information-composition.md"])(
    "ships %s unchanged in exports and hosted seeds",
    async (name) => {
      const repositoryRoot = resolve(import.meta.dirname, "../..");
      const reference = `design-app/references/${name}`;
      const source = readFileSync(
        join(repositoryRoot, "agent/skills", reference),
        "utf8",
      );
      const outputRoot = join(
        mkdtempSync(join(tmpdir(), "interaction-skill-export-")),
        "payload",
      );
      const manifest = await exportAppCreationSkills({
        repositoryRoot,
        outputRoot,
      });

      expect(manifest.files.some((file) => file.path === reference)).toBe(true);
      expect(readFileSync(join(outputRoot, reference), "utf8")).toBe(source);
      expect(
        HOSTED_MANAGED_SKILL_CONTENTS.find((file) => file.path === reference)
          ?.content,
      ).toBe(source);
    },
  );
});
