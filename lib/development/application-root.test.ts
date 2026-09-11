import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDevelopmentApplication,
  createDevelopmentCycle,
} from "./application-root";
import { removeDevelopmentSnapshot } from "./local-mode";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "app-builder-development-application-")),
  );
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  const modulesRoot = join(repositoryRoot, "node_modules");
  const runsRoot = join(root, "runs");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(modulesRoot, { mode: 0o700 });
  await mkdir(runsRoot, { mode: 0o700 });
  await writeFile(join(repositoryRoot, "agent.ts"), "export const live = 1;\n");
  await writeFile(join(repositoryRoot, ".gitignore"), ".eve\nnode_modules\n");
  await mkdir(join(repositoryRoot, ".eve"), { mode: 0o700 });
  await writeFile(join(repositoryRoot, ".eve/stale.json"), "{}\n");
  execFileSync("/usr/bin/git", ["init", "--quiet", repositoryRoot]);
  execFileSync("/usr/bin/git", ["-C", repositoryRoot, "add", "."]);
  return { repositoryRoot: await realpath(repositoryRoot), runsRoot };
}

describe("development Eve application roots", () => {
  it("creates a fresh writable application without prior Eve state", async () => {
    const input = await fixture();
    const firstRun = await realpath(
      await mkdtemp(join(input.runsRoot, "run-")),
    );
    const secondRun = await realpath(
      await mkdtemp(join(input.runsRoot, "run-")),
    );
    const first = await createDevelopmentApplication({
      repositoryRoot: input.repositoryRoot,
      runRoot: firstRun,
    });
    await mkdir(join(first.root, ".eve"), { mode: 0o700 });
    await writeFile(join(first.root, ".eve/session.json"), "{}\n");
    const second = await createDevelopmentApplication({
      repositoryRoot: input.repositoryRoot,
      runRoot: secondRun,
    });

    expect(first.root).not.toBe(second.root);
    expect(await readFile(join(second.root, "agent.ts"), "utf8")).toContain(
      "live",
    );
    await expect(lstat(join(second.root, ".eve"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await lstat(join(second.root, "node_modules"))).isSymbolicLink(),
    ).toBe(true);
    await writeFile(join(second.root, "agent.ts"), "export const live = 2;\n");

    await removeDevelopmentSnapshot(firstRun);
    await removeDevelopmentSnapshot(secondRun);
  });

  it("creates fresh application and workflow state for every watcher cycle", async () => {
    const input = await fixture();
    const first = await createDevelopmentCycle({
      repositoryRoot: input.repositoryRoot,
      supervisorRoot: input.runsRoot,
    });
    await writeFile(join(first.workflowData, "stuck-run.json"), "{}\n");
    await mkdir(join(first.application.root, ".eve"), { mode: 0o700 });
    await writeFile(join(first.application.root, ".eve/queue.json"), "{}\n");

    const second = await createDevelopmentCycle({
      repositoryRoot: input.repositoryRoot,
      supervisorRoot: input.runsRoot,
    });

    expect(second.root).not.toBe(first.root);
    expect(second.application.root).not.toBe(first.application.root);
    expect(second.workflowData).not.toBe(first.workflowData);
    await expect(
      lstat(join(second.workflowData, "stuck-run.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(second.application.root, ".eve")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
