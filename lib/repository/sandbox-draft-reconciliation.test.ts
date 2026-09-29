import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxSession } from "eve/sandbox";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectDraftReconciliation,
  prepareDraftReconciliation,
  readDraftReconciliationConflict,
  readDraftReconciliationDiff,
  writeDraftReconciliationResolution,
} from "./sandbox-draft-reconciliation";

const temporary: string[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// oxlint-disable-next-line eslint/arrow-body-style -- keeps the path-safety annotation beside the process call.
const git = (cwd: string, ...args: string[]) => {
  // oxlint-disable-next-line sonarjs/no-os-command-from-path -- Git is the fixed test fixture executable.
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
};

const fixture = (platformConflict = false) => {
  const root = mkdtempSync(path.join(tmpdir(), "builder-draft-merge-"));
  temporary.push(root);
  const remote = path.join(root, "remote.git");
  // oxlint-disable-next-line sonarjs/no-os-command-from-path -- Git initializes only this temporary test fixture.
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  git(root, "clone", remote, "repository");
  const checkout = path.join(root, "repository");
  git(checkout, "config", "user.name", "Fixture");
  git(checkout, "config", "user.email", "fixture@example.test");
  git(checkout, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(checkout, "apps/demo/tests"), { recursive: true });
  mkdirSync(path.join(checkout, "docs"), { recursive: true });
  writeFileSync(path.join(checkout, "apps/demo/tests/journey.spec.ts"), "initial\n");
  writeFileSync(path.join(checkout, "docs/platform.md"), "initial\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "initial");
  git(checkout, "push", "origin", "main");
  git(checkout, "switch", "-c", "draft");
  writeFileSync(path.join(checkout, "apps/demo/tests/journey.spec.ts"), "draft\n");
  if (platformConflict) {
    writeFileSync(path.join(checkout, "docs/platform.md"), "draft\n");
  }
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "draft");
  const headSha = git(checkout, "rev-parse", "HEAD");
  git(checkout, "push", "origin", "draft");
  git(checkout, "switch", "main");
  writeFileSync(path.join(checkout, "apps/demo/tests/journey.spec.ts"), "main\n");
  writeFileSync(path.join(checkout, "docs/platform.md"), "main\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "main moved");
  const baseSha = git(checkout, "rev-parse", "HEAD");
  git(checkout, "push", "origin", "main");
  git(checkout, "switch", "draft");
  // SAFETY: The fake implements only SandboxSession methods used by this module.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- focused sandbox fixture.
  const sandbox = {
    id: "fixture-sandbox",
    // oxlint-disable-next-line eslint/require-await -- mock mirrors asynchronous SandboxSession API.
    async readTextFile(input: { path: string }) {
      return readFileSync(path.join(root, input.path), "utf-8");
    },
    // oxlint-disable-next-line eslint/require-await -- mock mirrors asynchronous SandboxSession API.
    async removePath(input: { path: string }) {
      rmSync(path.join(root, input.path), { force: true });
    },
    // oxlint-disable-next-line eslint/require-await -- mock mirrors asynchronous SandboxSession API.
    async run(input: { command: string }) {
      if (input.command.includes("'remote' 'get-url' 'origin'")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "https://github.com/withAutograph/arrusted-development.git\n",
        };
      }
      const result = spawnSync("/bin/sh", ["-c", input.command], {
        cwd: root,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
      });
      return {
        exitCode: result.status ?? 1,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    },
    // oxlint-disable-next-line eslint/require-await -- mock mirrors asynchronous SandboxSession API.
    async writeBinaryFile(input: { path: string; content: Uint8Array }) {
      writeFileSync(path.join(root, input.path), input.content);
    },
    // oxlint-disable-next-line eslint/require-await -- mock mirrors asynchronous SandboxSession API.
    async writeTextFile(input: { path: string; content: string }) {
      writeFileSync(path.join(root, input.path), input.content);
    },
  } as unknown as SandboxSession;
  return { baseSha, headSha, root, sandbox };
};

describe("isolated draft reconciliation", () => {
  it("does not replay reviewed files already published to the draft head", async () => {
    const { root, sandbox, headSha, baseSha } = fixture();
    const prepared = await prepareDraftReconciliation({
      appId: "demo",
      baseBranch: "main",
      baseSha,
      headBranch: "draft",
      headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox,
      unpublished: {
        changes: [
          {
            after: { digest: digest("draft\n"), mode: "644" },
            before: { digest: digest("initial\n"), mode: "644" },
            kind: "modified",
            path: "apps/demo/tests/journey.spec.ts",
          },
        ],
        contentSource: {
          // oxlint-disable-next-line eslint/require-await -- a replay must not read the old workspace.
          async readFile() {
            throw new Error("already published files must not be read");
          },
        },
        reviewDigest: "a".repeat(64),
      },
      workspaceRoot: root,
    });
    expect(git(prepared.root, "rev-parse", "HEAD")).toBe(headSha);
    expect(prepared.conflicts).toEqual(["apps/demo/tests/journey.spec.ts"]);
  });

  it("combines an app conflict with current main and reviews both deltas", async () => {
    const { root, sandbox, headSha, baseSha } = fixture();
    const prepared = await prepareDraftReconciliation({
      appId: "demo",
      baseBranch: "main",
      baseSha,
      headBranch: "draft",
      headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox,
      workspaceRoot: root,
    });
    expect(prepared.conflicts).toEqual(["apps/demo/tests/journey.spec.ts"]);
    const resumed = await prepareDraftReconciliation({
      appId: "demo",
      baseBranch: "main",
      baseSha,
      headBranch: "draft",
      headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox,
      workspaceRoot: root,
    });
    expect(resumed.root).toBe(prepared.root);
    expect(resumed.conflicts).toEqual(prepared.conflicts);
    expect(
      await readDraftReconciliationConflict({
        path: "apps/demo/tests/journey.spec.ts",
        prepared,
        sandbox,
      }),
    ).toContain("<<<<<<<");
    await writeDraftReconciliationResolution({
      content: "main\ndraft\n",
      path: "apps/demo/tests/journey.spec.ts",
      prepared,
      sandbox,
    });
    const result = await inspectDraftReconciliation({ prepared, sandbox });
    expect(result.unresolvedConflicts).toEqual([]);
    expect(result.baseChanges.map(({ path: changed }) => changed)).toEqual([
      "apps/demo/tests/journey.spec.ts",
    ]);
    expect(result.headChanges.map(({ path: changed }) => changed)).toEqual([
      "apps/demo/tests/journey.spec.ts",
      "docs/platform.md",
    ]);
    expect(result.resolvedTree).toMatch(/^[0-9a-f]{40}$/u);
    const baseDiff = await readDraftReconciliationDiff({
      against: "base",
      prepared,
      resolvedTree: result.resolvedTree,
      sandbox,
    });
    expect(Buffer.from(baseDiff.chunkBase64, "base64").toString("utf-8")).toContain("+draft");
    expect(baseDiff.nextCursor).toBeNull();
    const headDiff = await readDraftReconciliationDiff({
      against: "head",
      prepared,
      resolvedTree: result.resolvedTree,
      sandbox,
    });
    expect(Buffer.from(headDiff.chunkBase64, "base64").toString("utf-8")).toContain(
      "docs/platform.md",
    );
  });

  it("names and stops at a platform-owned conflict", async () => {
    const { root, sandbox, headSha, baseSha } = fixture(true);
    await expect(
      prepareDraftReconciliation({
        appId: "demo",
        baseBranch: "main",
        baseSha,
        headBranch: "draft",
        headSha,
        repository: { name: "arrusted-development", owner: "withAutograph" },
        sandbox,
        workspaceRoot: root,
      }),
    ).rejects.toThrow("docs/platform.md");
  });
});
