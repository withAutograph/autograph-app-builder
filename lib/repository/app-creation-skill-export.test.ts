import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
});
