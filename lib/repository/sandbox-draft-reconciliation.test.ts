import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxSession } from "eve/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectDraftReconciliation,
  nonAppIndexDigest,
  prepareDraftReconciliation,
  readDraftReconciliationCandidateFile,
  readDraftReconciliationCandidateFilePage,
  readDraftReconciliationConflict,
  readDraftReconciliationDiff,
  replaceDraftReconciliationCandidateText,
  restoreDraftReconciliationCandidateFile,
  writeDraftReconciliationResolution,
} from "./sandbox-draft-reconciliation";

import { retireUnusedDraftWorktrees } from "./retire-unused-draft-worktrees";
import { attachCheckoutDependencyView } from "./dependency-cache";

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

const fixture = (platformConflict = false, dependencyWorkspace = false) => {
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
  if (dependencyWorkspace) {
    mkdirSync(path.join(checkout, "packages/probe"), { recursive: true });
    writeFileSync(path.join(checkout, ".gitignore"), "node_modules/\n");
    writeFileSync(
      path.join(checkout, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    writeFileSync(
      path.join(checkout, "packages/probe/package.json"),
      JSON.stringify({
        name: "@fixture/probe",
        type: "module",
        exports: "./index.js",
        bin: { "workspace-probe": "./bin.cjs" },
      }),
    );
    writeFileSync(
      path.join(checkout, "packages/probe/index.js"),
      'import { config } from "@vercel/microfrontends/config"; export const value = "initial:" + config;\n',
    );
    writeFileSync(
      path.join(checkout, "packages/probe/bin.cjs"),
      `#!${process.execPath}\nconsole.log("initial-workspace-tool");\n`,
    );
    chmodSync(path.join(checkout, "packages/probe/bin.cjs"), 0o755);
  }
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
  if (dependencyWorkspace) {
    writeFileSync(
      path.join(checkout, "packages/probe/index.js"),
      'import { config } from "@vercel/microfrontends/config"; export const value = "merged-main:" + config;\n',
    );
    writeFileSync(
      path.join(checkout, "packages/probe/bin.cjs"),
      `#!${process.execPath}\nconsole.log("merged-workspace-tool");\n`,
    );
  }
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "main moved");
  const baseSha = git(checkout, "rev-parse", "HEAD");
  git(checkout, "push", "origin", "main");
  git(checkout, "switch", "draft");
  git(checkout, "config", "--unset", "user.name");
  git(checkout, "config", "--unset", "user.email");
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
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          HOME: root,
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

const candidateFixtureInput = (f: ReturnType<typeof fixture>, baseSha = f.baseSha) => ({
  appId: "demo",
  baseBranch: "main",
  baseSha,
  headBranch: "draft",
  headSha: f.headSha,
  repository: { name: "arrusted-development", owner: "withAutograph" },
  sandbox: f.sandbox,
  workspaceRoot: f.root,
});

const advanceFixtureBase = (
  f: ReturnType<typeof fixture>,
  files: Record<string, string | null>,
) => {
  const checkout = path.join(f.root, "repository");
  git(checkout, "switch", "main");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(checkout, relative);
    if (content === null) {
      rmSync(target);
    } else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  git(checkout, "add", "--all", "--", ...Object.keys(files));
  git(
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "advance fixture base",
  );
  git(checkout, "push", "origin", "main");
  return git(checkout, "rev-parse", "HEAD");
};

describe("isolated draft reconciliation", () => {
  const catalogCandidate = async () => {
    const f = fixture(false, true);
    const prepared = await prepareDraftReconciliation(candidateFixtureInput(f));
    writeFileSync(
      path.join(prepared.root, "apps/demo/tests/journey.spec.ts"),
      "resolved app edit\n",
    );
    await inspectDraftReconciliation({ sandbox: f.sandbox, prepared });
    const files = [
      {
        path: "package.json",
        content: '{"private":true,"workspaces":["packages/*"],"catalog":{"probe":"1.0.0"}}\n',
      },
      {
        path: "packages/probe/package.json",
        content: '{"name":"@fixture/probe","dependencies":{"probe":"catalog:"}}\n',
      },
      { path: "bun.lock", content: "normalized catalog lock\n" },
    ];
    for (const file of files) {
      writeFileSync(path.join(prepared.root, file.path), file.content);
    }
    git(prepared.root, "add", "--", ...files.map((file) => file.path));
    const dependencyCatalog = {
      files: files.map((file) => ({ path: file.path, digest: digest(file.content) })),
      nonAppIndexDigest: await nonAppIndexDigest(f.sandbox, prepared.root, "demo"),
    };
    return { f, prepared: { ...prepared, dependencyCatalog } };
  };

  it("reviews and reuses exact normalized catalog files while preserving app edits", async () => {
    const { f, prepared } = await catalogCandidate();
    const inspected = await inspectDraftReconciliation({ sandbox: f.sandbox, prepared });
    expect(inspected.baseChanges.map((change) => change.path)).toEqual(
      expect.arrayContaining([
        "package.json",
        "packages/probe/package.json",
        "bun.lock",
        "apps/demo/tests/journey.spec.ts",
      ]),
    );
    const retained = await prepareDraftReconciliation({
      ...candidateFixtureInput(f),
      previousCandidate: prepared,
      replayPreviousCandidate: true,
    });
    expect(retained.root).toBe(prepared.root);
    expect(retained.dependencyCatalog).toEqual(prepared.dependencyCatalog);
    expect(readFileSync(path.join(retained.root, "apps/demo/tests/journey.spec.ts"), "utf-8")).toBe(
      "resolved app edit\n",
    );
    const retainedInspection = await inspectDraftReconciliation({
      sandbox: f.sandbox,
      prepared: retained,
    });
    expect(retainedInspection.resolvedTree).toBe(inspected.resolvedTree);
  });

  it("allows ordinary selected-app manifest edits after catalog normalization", async () => {
    const { f, prepared } = await catalogCandidate();
    const appManifest = "apps/demo/package.json";
    const normalized = '{"name":"demo","devDependencies":{"probe":"catalog:"}}\n';
    writeFileSync(path.join(prepared.root, appManifest), normalized);
    git(prepared.root, "add", "--", appManifest);
    const candidate = {
      ...prepared,
      dependencyCatalog: {
        ...prepared.dependencyCatalog,
        files: [
          ...prepared.dependencyCatalog.files,
          { path: appManifest, digest: digest(normalized) },
        ],
      },
    };
    const changed =
      '{"name":"demo","devDependencies":{"probe":"catalog:"},"scripts":{"test":"existing task --run"}}\n';
    writeFileSync(path.join(prepared.root, appManifest), changed);
    const observed = await inspectDraftReconciliation({ sandbox: f.sandbox, prepared: candidate });
    expect(
      observed.baseChanges.some(
        (change) => change.path === appManifest && change.after?.digest === digest(changed),
      ),
    ).toBe(true);
    expect(observed.unresolvedConflicts).toEqual([]);
  });

  it.each([
    "unstaged bytes",
    "staged bytes",
    "unrelated staged file",
    "unrelated unstaged file",
    "symlink",
    "parent symlink",
    "file mode",
  ])("rejects catalog receipt tampering: %s", async (change) => {
    const { f, prepared } = await catalogCandidate();
    if (change === "unstaged bytes" || change === "staged bytes") {
      writeFileSync(path.join(prepared.root, "package.json"), "tampered\n");
      if (change === "staged bytes") {
        git(prepared.root, "add", "package.json");
      }
    } else if (change === "file mode") {
      chmodSync(path.join(prepared.root, "package.json"), 0o755);
    } else if (change === "symlink") {
      const target = path.join(f.root, "external-package.json");
      writeFileSync(target, readFileSync(path.join(prepared.root, "package.json")));
      rmSync(path.join(prepared.root, "package.json"));
      symlinkSync(target, path.join(prepared.root, "package.json"));
    } else if (change === "parent symlink") {
      const target = path.join(f.root, "external-probe");
      mkdirSync(target);
      writeFileSync(
        path.join(target, "package.json"),
        readFileSync(path.join(prepared.root, "packages/probe/package.json")),
      );
      rmSync(path.join(prepared.root, "packages/probe"), { recursive: true });
      symlinkSync(target, path.join(prepared.root, "packages/probe"));
    } else {
      writeFileSync(path.join(prepared.root, "docs/platform.md"), "unauthorized\n");
      if (change === "unrelated staged file") {
        git(prepared.root, "add", "docs/platform.md");
      }
    }
    await expect(inspectDraftReconciliation({ sandbox: f.sandbox, prepared })).rejects.toThrow();
  });

  it("rejects receipts authorizing non-manifest paths", async () => {
    const { f, prepared } = await catalogCandidate();
    prepared.dependencyCatalog.files.push({ path: "docs/platform.md", digest: digest("main\n") });
    await expect(inspectDraftReconciliation({ sandbox: f.sandbox, prepared })).rejects.toThrow(
      "receipt is invalid",
    );
  });

  it("does not replay catalog authority into a fresh candidate after main advances", async () => {
    const { f, prepared } = await catalogCandidate();
    const baseSha = advanceFixtureBase(f, { "docs/next.md": "new main\n" });
    const next = await prepareDraftReconciliation({
      ...candidateFixtureInput(f, baseSha),
      previousCandidate: prepared,
      replayPreviousCandidate: true,
    });
    expect(next.root).not.toBe(prepared.root);
    expect(next.dependencyCatalog).toBeUndefined();
    expect(existsSync(path.join(next.root, "bun.lock"))).toBe(false);
    expect(readFileSync(path.join(next.root, "apps/demo/tests/journey.spec.ts"), "utf-8")).toBe(
      "resolved app edit\n",
    );
  });

  it("reuses the checkout dependency closure while binding workspace imports to candidate source", async () => {
    const f = fixture(false, true);
    const checkout = path.join(f.root, "repository");
    const closure = path.join(f.root, "installed/node_modules");
    const externalPackage = path.join(closure, "@vercel/microfrontends");
    const externalTool = path.join(f.root, "installed/bin/probe.cjs");
    mkdirSync(path.dirname(externalTool), { recursive: true });
    writeFileSync(externalTool, `#!${process.execPath}\nconsole.log("external-cached-tool");\n`);
    chmodSync(externalTool, 0o755);
    const externalToolBytes = readFileSync(externalTool);
    const externalToolMode = lstatSync(externalTool).mode;
    mkdirSync(path.join(closure, ".bin"), { recursive: true });
    symlinkSync("../../bin/probe.cjs", path.join(closure, ".bin/probe"));
    symlinkSync(
      path.join(checkout, "packages/probe/bin.cjs"),
      path.join(closure, ".bin/workspace-probe"),
    );
    const executeWorkspaceTool = (cwd: string) =>
      execFileSync(path.join(cwd, "node_modules/.bin/workspace-probe"), [], {
        cwd,
        encoding: "utf-8",
      }).trim();
    const executeTool = (cwd: string) =>
      execFileSync(path.join(cwd, "node_modules/.bin/probe"), [], {
        cwd,
        encoding: "utf-8",
      }).trim();
    mkdirSync(externalPackage, { recursive: true });
    mkdirSync(path.join(closure, "@fixture"), { recursive: true });
    writeFileSync(
      path.join(externalPackage, "package.json"),
      JSON.stringify({
        name: "@vercel/microfrontends",
        type: "module",
        exports: { "./config": "./config.js" },
      }),
    );
    const installedSource = path.join(externalPackage, "config.js");
    writeFileSync(installedSource, 'export const config = "reused-external-config";\n');
    const installedBytes = readFileSync(installedSource);
    const installedMode = lstatSync(installedSource).mode;
    symlinkSync(path.join(checkout, "packages/probe"), path.join(closure, "@fixture/probe"));
    symlinkSync(closure, path.join(checkout, "node_modules"));
    const importValue = (cwd: string) =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          'import { value } from "@fixture/probe"; console.log(value);',
        ],
        { cwd, encoding: "utf-8" },
      ).trim();
    expect(importValue(checkout)).toBe("initial:reused-external-config");
    expect(executeTool(checkout)).toBe("external-cached-tool");
    expect(executeWorkspaceTool(checkout)).toBe("initial-workspace-tool");
    const input = {
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha: f.headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    };
    const prepared = await prepareDraftReconciliation(input);
    expect(importValue(prepared.root)).toBe("merged-main:reused-external-config");
    expect(executeTool(prepared.root)).toBe("external-cached-tool");
    expect(realpathSync(path.join(prepared.root, "node_modules/.bin/probe"))).toBe(
      realpathSync(externalTool),
    );
    expect(executeWorkspaceTool(prepared.root)).toBe("merged-workspace-tool");
    const repaired = path.join(prepared.root, "apps/demo/tests/journey.spec.ts");
    const added = path.join(prepared.root, "apps/demo/tests/new-repair.txt");
    writeFileSync(repaired, "retained candidate repair\n");
    writeFileSync(added, "retained new file\n");
    const resolved = await inspectDraftReconciliation({ prepared, sandbox: f.sandbox });
    expect(resolved.unresolvedConflicts).toEqual([]);
    expect(resolved.baseChanges.map((change) => change.path)).toContain(
      "apps/demo/tests/new-repair.txt",
    );
    expect(
      [...resolved.baseChanges, ...resolved.headChanges].some((change) =>
        change.path.split("/").includes("node_modules"),
      ),
    ).toBe(false);
    const retained = await prepareDraftReconciliation({
      ...input,
      previousCandidate: prepared,
      replayPreviousCandidate: true,
    });
    expect(importValue(retained.root)).toBe("merged-main:reused-external-config");
    expect(executeTool(retained.root)).toBe("external-cached-tool");
    expect(executeWorkspaceTool(retained.root)).toBe("merged-workspace-tool");
    const inspected = await inspectDraftReconciliation({ prepared: retained, sandbox: f.sandbox });
    expect(inspected.unresolvedConflicts).toEqual([]);
    expect(inspected.baseChanges.map((change) => change.path)).toContain(
      "apps/demo/tests/new-repair.txt",
    );
    expect(
      [...inspected.baseChanges, ...inspected.headChanges].some((change) =>
        change.path.split("/").includes("node_modules"),
      ),
    ).toBe(false);
    expect(readFileSync(path.join(retained.root, "apps/demo/tests/journey.spec.ts"), "utf-8")).toBe(
      "retained candidate repair\n",
    );
    expect(readFileSync(path.join(retained.root, "apps/demo/tests/new-repair.txt"), "utf-8")).toBe(
      "retained new file\n",
    );
    expect(importValue(checkout)).toBe("initial:reused-external-config");
    expect(readFileSync(installedSource)).toEqual(installedBytes);
    expect(lstatSync(installedSource).mode).toBe(installedMode);
    expect(readFileSync(externalTool)).toEqual(externalToolBytes);
    expect(lstatSync(externalTool).mode).toBe(externalToolMode);
  });

  it("pages a large long-line candidate completely without transferring its full text through the sandbox API", async () => {
    const f = fixture();
    const prepared = await prepareDraftReconciliation({
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha: f.headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    });
    const selected = "apps/demo/tests/large.txt";
    const content = `${"x".repeat(32_767)}🙂é${"z".repeat(1_400_000)}`;
    writeFileSync(path.join(prepared.root, selected), content);
    let largestOutput = 0;
    const sandbox = {
      ...f.sandbox,
      readTextFile() {
        return Promise.reject(
          new Error("This source reader has no whole-file text transfer capability."),
        );
      },
      async run(input: Parameters<SandboxSession["run"]>[0]) {
        const result = await f.sandbox.run(input);
        largestOutput = Math.max(largestOutput, Buffer.byteLength(result.stdout));
        return result;
      },
    };
    const pages: string[] = [];
    let nextCursor: number | null = 0;
    do {
      const cursor = nextCursor;
      const page: Awaited<ReturnType<typeof readDraftReconciliationCandidateFilePage>> =
        // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- each page continues its predecessor's returned UTF-8 cursor.
        await readDraftReconciliationCandidateFilePage({
          cursor,
          expectedDigest: digest(content),
          path: selected,
          prepared,
          sandbox,
        });
      expect(page.cursor).toBe(cursor);
      expect(page.digest).toBe(digest(content));
      expect(page.totalBytes).toBe(Buffer.byteLength(content));
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(32_768);
      expect(page).not.toHaveProperty("sourceChanged");
      pages.push(page.content);
      if (page.nextCursor !== null) {
        expect(page.nextCursor).toBe(cursor + Buffer.byteLength(page.content));
        expect(page.nextCursor).toBeGreaterThan(cursor);
      }
      nextCursor = page.nextCursor;
    } while (nextCursor !== null);
    expect(pages.join("")).toBe(content);
    expect(largestOutput).toBeLessThanOrEqual(6 * 32_768 + 512);
    await expect(
      replaceDraftReconciliationCandidateText({
        expectedDigest: digest(content),
        newText: "edited",
        oldText: "🙂é",
        path: selected,
        prepared,
        sandbox: f.sandbox,
      }),
    ).resolves.toEqual({ digest: digest(content.replace("🙂é", "edited")) });
  }, 30_000);

  it("returns empty files and exact EOF, and resets a shortened changed file to its fresh first page", async () => {
    const f = fixture();
    const prepared = await prepareDraftReconciliation({
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha: f.headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    });
    const selected = "apps/demo/tests/changing.txt";
    const file = path.join(prepared.root, selected);
    writeFileSync(file, "");
    const input = { path: selected, prepared, sandbox: f.sandbox };
    await expect(readDraftReconciliationCandidateFilePage(input)).resolves.toEqual({
      content: "",
      cursor: 0,
      digest: digest(""),
      nextCursor: null,
      totalBytes: 0,
    });
    writeFileSync(file, "a".repeat(100_000));
    const first = await readDraftReconciliationCandidateFilePage(input);
    expect(first.nextCursor).toBe(32_768);
    const changed = "short🙂";
    writeFileSync(file, changed);
    await expect(
      readDraftReconciliationCandidateFilePage({
        ...input,
        cursor: first.nextCursor ?? 0,
        expectedDigest: first.digest,
      }),
    ).resolves.toEqual({
      content: changed,
      cursor: 0,
      digest: digest(changed),
      nextCursor: null,
      sourceChanged: true,
      totalBytes: Buffer.byteLength(changed),
    });
    await expect(
      readDraftReconciliationCandidateFilePage({ ...input, cursor: Buffer.byteLength(changed) }),
    ).resolves.toMatchObject({ content: "", nextCursor: null });
    await expect(
      readDraftReconciliationCandidateFilePage({
        ...input,
        cursor: Buffer.byteLength(changed) + 1,
      }),
    ).rejects.toThrow("past the end");
  });

  it("preserves UTF-8 boundaries and the SDK's text digest semantics, including BOM and escaped output", async () => {
    const f = fixture();
    const prepared = await prepareDraftReconciliation({
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha: f.headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    });
    const selected = "apps/demo/tests/unicode.txt";
    const normalized = `${"\u0001".repeat(32_767)}🙂\uFEFFtail`;
    writeFileSync(path.join(prepared.root, selected), `\uFEFF${normalized}`);
    const input = { path: selected, prepared, sandbox: f.sandbox };
    const first = await readDraftReconciliationCandidateFilePage(input);
    expect(first.content).toBe("\u0001".repeat(32_767));
    expect(first.digest).toBe(digest(normalized));
    expect(first.totalBytes).toBe(Buffer.byteLength(normalized));
    const tail = await readDraftReconciliationCandidateFilePage({
      ...input,
      cursor: first.nextCursor ?? 0,
      expectedDigest: first.digest,
    });
    expect(tail.content).toBe("🙂\uFEFFtail");
    expect(tail.nextCursor).toBeNull();
    expect(first.content + tail.content).toBe(normalized);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(6 * 32_768 + 512);
    writeFileSync(path.join(prepared.root, selected), Buffer.from([0xc3, 0x28]));
    await expect(readDraftReconciliationCandidateFilePage(input)).rejects.toThrow("encoded data");
  });

  it("preserves candidate ownership and symlink isolation for paged reads", async () => {
    const f = fixture();
    const prepared = await prepareDraftReconciliation({
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha: f.headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    });
    const input = { prepared, sandbox: f.sandbox };
    await expect(
      readDraftReconciliationCandidateFilePage({ ...input, path: "docs/platform.md" }),
    ).rejects.toThrow("outside apps/demo/");
    await expect(
      readDraftReconciliationCandidateFilePage({
        ...input,
        path: "apps/demo/../../docs/platform.md",
      }),
    ).rejects.toThrow("outside apps/demo/");
    const outside = path.join(f.root, "private.txt");
    writeFileSync(outside, "private fixture content");
    symlinkSync(outside, path.join(prepared.root, "apps/demo/link.txt"));
    await expect(
      readDraftReconciliationCandidateFilePage({ ...input, path: "apps/demo/link.txt" }),
    ).rejects.toThrow("symlink in app path");
  });

  it.each([0o644, 0o755])(
    "restores only the selected retained binary blob and mode %s without checkout filters",
    async (mode) => {
      const f = fixture();
      const checkout = path.join(f.root, "repository");
      const selected = "apps/demo/archive/[issued].bin";
      const other = "apps/demo/archive/i.bin";
      const retained = Buffer.alloc(150_000, 0xff);
      retained.set([0, 0xc3, 0x28, 10, 13, 10]);
      mkdirSync(path.dirname(path.join(checkout, selected)), { recursive: true });
      writeFileSync(path.join(checkout, selected), retained);
      chmodSync(path.join(checkout, selected), mode);
      writeFileSync(path.join(checkout, other), "retained unrelated file\n");
      git(checkout, "add", "apps/demo/archive");
      git(
        checkout,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "retain binary app artifact",
      );
      const headSha = git(checkout, "rev-parse", "HEAD");
      git(checkout, "push", "origin", "draft");
      const prepared = await prepareDraftReconciliation({
        appId: "demo",
        baseBranch: "main",
        baseSha: f.baseSha,
        headBranch: "draft",
        headSha,
        repository: { name: "arrusted-development", owner: "withAutograph" },
        sandbox: f.sandbox,
        workspaceRoot: f.root,
      });
      const destination = path.join(prepared.root, selected);
      writeFileSync(destination, "changed issued file\n");
      chmodSync(destination, mode === 0o755 ? 0o644 : 0o755);
      writeFileSync(path.join(prepared.root, other), "unrelated app repair\n");
      writeFileSync(path.join(prepared.root, "apps/demo/new-file.txt"), "new app repair\n");
      writeFileSync(
        path.join(prepared.root, "apps/demo/archive/.gitattributes"),
        "*.bin filter=fixture\n",
      );
      git(prepared.root, "config", "filter.fixture.smudge", "false");
      git(prepared.root, "config", "filter.fixture.required", "true");
      const unrelatedIndex = git(prepared.root, "ls-files", "--stage", "--", other);

      await expect(
        restoreDraftReconciliationCandidateFile({ path: selected, prepared, sandbox: f.sandbox }),
      ).resolves.toEqual({
        digest: createHash("sha256").update(retained).digest("hex"),
        mode: mode === 0o755 ? "755" : "644",
      });

      expect(readFileSync(destination)).toEqual(retained);
      // oxlint-disable-next-line eslint/no-bitwise -- POSIX permission bits establish the restored Git executable mode.
      expect(lstatSync(destination).mode & 0o777).toBe(mode);
      const retainedBlob = git(prepared.root, "rev-parse", `${headSha}:${selected}`);
      expect(git(prepared.root, "--literal-pathspecs", "ls-files", "--stage", "--", selected)).toBe(
        `${mode === 0o755 ? "100755" : "100644"} ${retainedBlob} 0\t${selected}`,
      );
      expect(readFileSync(path.join(prepared.root, other), "utf-8")).toBe("unrelated app repair\n");
      expect(readFileSync(path.join(prepared.root, "apps/demo/new-file.txt"), "utf-8")).toBe(
        "new app repair\n",
      );
      expect(git(prepared.root, "ls-files", "--stage", "--", other)).toBe(unrelatedIndex);
      expect(readFileSync(path.join(prepared.root, "docs/platform.md"), "utf-8")).toBe("main\n");
    },
  );

  it("rejects unowned, unsafe, missing, and nonregular retained sources before changing candidate bytes", async () => {
    const f = fixture();
    const checkout = path.join(f.root, "repository");
    symlinkSync("tests/journey.spec.ts", path.join(checkout, "apps/demo/retained-link"));
    git(checkout, "add", "apps/demo/retained-link");
    git(
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "retain app symlink",
    );
    const headSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "push", "origin", "draft");
    const prepared = await prepareDraftReconciliation({
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    });
    const selected = "apps/demo/tests/journey.spec.ts";
    const destination = path.join(prepared.root, selected);
    writeFileSync(destination, "keep this repair\n");
    writeFileSync(path.join(prepared.root, "apps/demo/not-in-head.txt"), "keep new file\n");
    rmSync(path.join(prepared.root, "apps/demo/retained-link"));
    writeFileSync(path.join(prepared.root, "apps/demo/retained-link"), "keep replaced symlink\n");
    const index = readFileSync(git(prepared.root, "rev-parse", "--git-path", "index"));
    for (const unsafe of [
      "docs/platform.md",
      "apps/other/file.txt",
      "apps/demo/../other/file.txt",
      "apps/demo/not-in-head.txt",
      "apps/demo/retained-link",
      "apps/demo/tests",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- verify every rejected mutation against the same preserved candidate.
      await expect(
        restoreDraftReconciliationCandidateFile({ path: unsafe, prepared, sandbox: f.sandbox }),
      ).rejects.toThrow();
    }
    expect(readFileSync(destination, "utf-8")).toBe("keep this repair\n");
    expect(readFileSync(path.join(prepared.root, "apps/demo/not-in-head.txt"), "utf-8")).toBe(
      "keep new file\n",
    );
    expect(readFileSync(path.join(prepared.root, "apps/demo/retained-link"), "utf-8")).toBe(
      "keep replaced symlink\n",
    );
    expect(readFileSync(git(prepared.root, "rev-parse", "--git-path", "index"))).toEqual(index);

    const external = path.join(f.root, "external");
    mkdirSync(external);
    writeFileSync(path.join(external, "journey.spec.ts"), "outside app\n");
    rmSync(destination);
    symlinkSync(path.join(external, "journey.spec.ts"), destination);
    await expect(
      restoreDraftReconciliationCandidateFile({ path: selected, prepared, sandbox: f.sandbox }),
    ).rejects.toThrow("symlink in app path");
    rmSync(path.dirname(destination), { recursive: true });
    symlinkSync(external, path.dirname(destination));
    await expect(
      restoreDraftReconciliationCandidateFile({ path: selected, prepared, sandbox: f.sandbox }),
    ).rejects.toThrow("symlink in app path");
    expect(readFileSync(path.join(external, "journey.spec.ts"), "utf-8")).toBe("outside app\n");
    expect(readFileSync(git(prepared.root, "rev-parse", "--git-path", "index"))).toEqual(index);
  });

  it("makes an exact app-owned candidate edit without rewriting other test coverage", async () => {
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
    await writeDraftReconciliationResolution({
      content: "main\ndraft\n",
      path: "apps/demo/tests/journey.spec.ts",
      prepared,
      sandbox,
    });
    const file = await readDraftReconciliationCandidateFile({
      path: "apps/demo/tests/journey.spec.ts",
      prepared,
      sandbox,
    });
    expect(file).toEqual({ content: "main\ndraft\n", digest: digest("main\ndraft\n") });
    await expect(
      replaceDraftReconciliationCandidateText({
        expectedDigest: file.digest,
        newText: "draft with wait",
        oldText: "draft",
        path: "apps/demo/tests/journey.spec.ts",
        prepared,
        sandbox,
      }),
    ).resolves.toEqual({ digest: digest("main\ndraft with wait\n") });
    const edited = await readDraftReconciliationCandidateFile({
      path: "apps/demo/tests/journey.spec.ts",
      prepared,
      sandbox,
    });
    expect(edited.content).toBe("main\ndraft with wait\n");
    await expect(
      replaceDraftReconciliationCandidateText({
        expectedDigest: edited.digest,
        newText: "different",
        oldText: "a",
        path: "apps/demo/tests/journey.spec.ts",
        prepared,
        sandbox,
      }),
    ).rejects.toThrow("must occur exactly once");
    await expect(
      replaceDraftReconciliationCandidateText({
        expectedDigest: file.digest,
        newText: "other",
        oldText: "main",
        path: "apps/demo/tests/journey.spec.ts",
        prepared,
        sandbox,
      }),
    ).rejects.toThrow("changed since inspection");
    await expect(
      readDraftReconciliationCandidateFile({
        path: "docs/platform.md",
        prepared,
        sandbox,
      }),
    ).rejects.toThrow("outside apps/demo/");
  });

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

  it.each([false, true])(
    "repairs an owned published preimage from the original main checkout (executable %s)",
    async (executable) => {
      const { root, sandbox, baseSha, headSha: originalHead } = fixture();
      const checkout = path.join(root, "repository");
      let publishedHead = originalHead;
      if (executable) {
        chmodSync(path.join(checkout, "apps/demo/tests/journey.spec.ts"), 0o755);
        git(checkout, "add", ".");
        git(
          checkout,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-m",
          "published executable",
        );
        publishedHead = git(checkout, "rev-parse", "HEAD");
      }
      writeFileSync(path.join(checkout, "apps/demo/retained.ts"), "third-party unrelated change\n");
      git(checkout, "add", ".");
      git(
        checkout,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "unrelated draft edit",
      );
      const liveHead = git(checkout, "rev-parse", "HEAD");
      git(checkout, "push", "origin", "draft");
      git(checkout, "switch", "main");
      const mode = executable ? "100755" : "100644";
      const prepared = await prepareDraftReconciliation({
        appId: "demo",
        baseBranch: "main",
        baseSha,
        headBranch: "draft",
        headSha: liveHead,
        repository: { name: "arrusted-development", owner: "withAutograph" },
        sandbox,
        workspaceRoot: root,
        unpublished: {
          priorPublishedHeadSha: publishedHead,
          reviewDigest: "c".repeat(64),
          changes: [
            {
              path: "apps/demo/tests/journey.spec.ts",
              kind: "modified",
              before: { digest: digest("main\n"), mode: "100644" },
              after: { digest: digest("repaired\n"), mode },
            },
          ],
          contentSource: {
            readFile: () =>
              Promise.resolve({
                bytes: Buffer.from("repaired\n"),
                digest: digest("repaired\n"),
                mode,
              }),
          },
        },
      });
      expect(git(prepared.root, "show", "HEAD:apps/demo/tests/journey.spec.ts")).toBe("repaired");
      expect(git(prepared.root, "show", "HEAD:apps/demo/retained.ts")).toBe(
        "third-party unrelated change",
      );
      expect(git(prepared.root, "ls-tree", "HEAD", "apps/demo/tests/journey.spec.ts")).toContain(
        executable ? "100755" : "100644",
      );
      expect(git(checkout, "rev-parse", "HEAD")).toBe(baseSha);
      expect(git(checkout, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      expect(readFileSync(path.join(checkout, "apps/demo/tests/journey.spec.ts"), "utf-8")).toBe(
        "main\n",
      );
      expect(git(checkout, "rev-parse", "refs/remotes/origin/draft")).toBe(liveHead);
    },
  );

  it.each([false, true])(
    "replays a second generated revision from its approved merge baseline while preserving third-party changes (%s)",
    async (thirdPartyChange) => {
      const { root, sandbox, baseSha } = fixture();
      const checkout = path.join(root, "repository");
      const relative = "apps/demo/generated/release.json";
      const generatedPath = path.join(checkout, relative);
      mkdirSync(path.dirname(generatedPath), { recursive: true });
      const published = '{"release":"approved-merge"}\n';
      const revised = '{"release":"second-revision"}\n';
      writeFileSync(generatedPath, published);
      git(checkout, "add", ".");
      git(
        checkout,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "approved merged generated result",
      );
      const publishedHead = git(checkout, "rev-parse", "HEAD");
      if (thirdPartyChange) {
        writeFileSync(generatedPath, '{"release":"someone-else"}\n');
        git(checkout, "add", ".");
        git(
          checkout,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-m",
          "independent generated edit",
        );
      }
      const headSha = git(checkout, "rev-parse", "HEAD");
      git(checkout, "push", "origin", "draft");
      const readFile = () =>
        Promise.resolve({
          bytes: Buffer.from(revised),
          digest: digest(revised),
          mode: "100644",
        });
      const preparation = prepareDraftReconciliation({
        appId: "demo",
        baseBranch: "main",
        baseSha,
        headBranch: "draft",
        headSha,
        repository: { name: "arrusted-development", owner: "withAutograph" },
        sandbox,
        workspaceRoot: root,
        unpublished: {
          priorPublishedHeadSha: publishedHead,
          reviewDigest: "e".repeat(64),
          changes: [
            {
              path: relative,
              kind: "modified",
              before: { digest: digest('{"release":"selected-source"}\n'), mode: "100644" },
              after: { digest: digest(revised), mode: "100644" },
            },
          ],
          contentSource: { readFile },
        },
      });
      if (thirdPartyChange) {
        await expect(preparation).rejects.toThrow("matches neither");
        expect(readFileSync(generatedPath, "utf-8")).toBe('{"release":"someone-else"}\n');
        return;
      }
      const prepared = await preparation;
      expect(readFileSync(path.join(prepared.root, relative), "utf-8")).toBe(revised);
      expect(readFileSync(generatedPath, "utf-8")).toBe(published);
    },
  );

  it("preserves later third-party changes to the same published file", async () => {
    const { root, sandbox, baseSha, headSha: publishedHead } = fixture();
    const checkout = path.join(root, "repository");
    writeFileSync(
      path.join(checkout, "apps/demo/tests/journey.spec.ts"),
      "third-party replacement\n",
    );
    git(checkout, "add", ".");
    git(
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "third-party edit",
    );
    const headSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "push", "origin", "draft");
    git(checkout, "switch", "main");
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
        unpublished: {
          priorPublishedHeadSha: publishedHead,
          reviewDigest: "d".repeat(64),
          changes: [
            {
              path: "apps/demo/tests/journey.spec.ts",
              kind: "modified",
              before: { digest: digest("main\n"), mode: "100644" },
              after: { digest: digest("repaired\n"), mode: "100644" },
            },
          ],
          contentSource: {
            readFile: () => Promise.reject(new Error("must reject before loading the repair")),
          },
        },
      }),
    ).rejects.toThrow(
      "matches neither its reviewed starting content nor the complete reviewed result",
    );
    expect(git(checkout, "show", `${headSha}:apps/demo/tests/journey.spec.ts`)).toBe(
      "third-party replacement",
    );
    expect(git(checkout, "rev-parse", "HEAD")).toBe(baseSha);
  });

  it("explains when unpublished reviewed bytes were lost with the old sandbox", async () => {
    const { root, sandbox, headSha, baseSha } = fixture();
    let available = false;
    const input = {
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
            after: { digest: digest("new edit\n"), mode: "644" },
            before: { digest: digest("draft\n"), mode: "644" },
            kind: "modified",
            path: "apps/demo/tests/journey.spec.ts",
          },
        ],
        contentSource: {
          // oxlint-disable-next-line eslint/require-await -- sandbox file sources return promises.
          async readFile() {
            if (!available) {
              throw new Error("source overlay unavailable");
            }
            return {
              bytes: Buffer.from("new edit\n"),
              digest: digest("new edit\n"),
              mode: "644" as const,
            };
          },
        },
        reviewDigest: "b".repeat(64),
      },
      workspaceRoot: root,
    } as const;
    await expect(prepareDraftReconciliation(input)).rejects.toThrow(
      "recreate and review the missing edit",
    );
    available = true;
    const retried = await prepareDraftReconciliation(input);
    expect(retried.created).toBe(false);
    expect(git(retried.root, "rev-parse", "HEAD")).not.toBe(headSha);
    expect(retried.conflicts).toContain("apps/demo/tests/journey.spec.ts");
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
    const platformOnly = await readDraftReconciliationDiff({
      against: "head",
      path: "docs/platform.md",
      prepared,
      resolvedTree: result.resolvedTree,
      sandbox,
    });
    const platformText = Buffer.from(platformOnly.chunkBase64, "base64").toString("utf-8");
    expect(platformText).toContain("docs/platform.md");
    expect(platformText).not.toContain("apps/demo/tests/journey.spec.ts");
    const tail = await readDraftReconciliationDiff({
      against: "head",
      cursor: 12,
      path: "docs/platform.md",
      prepared,
      resolvedTree: result.resolvedTree,
      sandbox,
    });
    expect(Buffer.from(tail.chunkBase64, "base64").toString("utf-8")).toBe(platformText.slice(12));
    writeFileSync(path.join(prepared.root, "apps/demo/release.bin"), Buffer.from([0, 1, 2, 255]));
    git(prepared.root, "add", "--", "apps/demo/release.bin");
    const binaryTree = git(prepared.root, "write-tree");
    const binaryDiff = await readDraftReconciliationDiff({
      against: "base",
      path: "apps/demo/release.bin",
      prepared,
      resolvedTree: binaryTree,
      sandbox,
    });
    expect(Buffer.from(binaryDiff.chunkBase64, "base64").toString("utf-8")).toContain(
      "GIT binary patch",
    );
  });

  it("rebuilds outside-scope metadata contamination while preserving app repairs, renames, deletes, modes and the old index", async () => {
    const f = fixture();
    const checkout = path.join(f.root, "repository");
    writeFileSync(path.join(checkout, "apps/demo/obsolete.txt"), "old app file\n");
    writeFileSync(path.join(checkout, "apps/demo/rename-source.ts"), "renamed app repair\n");
    chmodSync(path.join(checkout, "apps/demo/rename-source.ts"), 0o755);
    writeFileSync(path.join(checkout, "apps/demo/file-to-directory"), "former file\n");
    mkdirSync(path.join(checkout, "apps/demo/directory-to-file/nested"), { recursive: true });
    writeFileSync(
      path.join(checkout, "apps/demo/directory-to-file/nested/leaf.ts"),
      "former child\n",
    );
    git(checkout, "add", "apps/demo");
    git(
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "app deletion fixture",
    );
    const headSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "push", "origin", "draft");
    const input = {
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    };
    const old = await prepareDraftReconciliation(input);
    await writeDraftReconciliationResolution({
      content: "main\ndraft repaired\n",
      path: "apps/demo/tests/journey.spec.ts",
      prepared: old,
      sandbox: f.sandbox,
    });
    git(old.root, "mv", "apps/demo/rename-source.ts", "apps/demo/rename-target.ts");
    rmSync(path.join(old.root, "apps/demo/file-to-directory"));
    mkdirSync(path.join(old.root, "apps/demo/file-to-directory"));
    writeFileSync(
      path.join(old.root, "apps/demo/file-to-directory/child.ts"),
      "replacement child\n",
    );
    rmSync(path.join(old.root, "apps/demo/directory-to-file/nested/leaf.ts"));
    rmdirSync(path.join(old.root, "apps/demo/directory-to-file/nested"));
    rmdirSync(path.join(old.root, "apps/demo/directory-to-file"));
    writeFileSync(path.join(old.root, "apps/demo/directory-to-file"), "replacement file\n");
    rmSync(path.join(old.root, "apps/demo/obsolete.txt"));
    writeFileSync(path.join(old.root, "apps/demo/repair.ts"), "app-owned repair\n");
    chmodSync(path.join(old.root, "apps/demo/repair.ts"), 0o755);
    await inspectDraftReconciliation({ sandbox: f.sandbox, prepared: old });
    writeFileSync(path.join(old.root, "bun.lock"), "observed root metadata\n");
    writeFileSync(path.join(old.root, "docs/platform.md"), "private outside-scope edit\n");
    git(old.root, "add", "docs/platform.md");
    writeFileSync(path.join(checkout, ".git/info/exclude"), "apps/demo/.env\n");
    writeFileSync(path.join(old.root, "apps/demo/.env"), "ignored-private-fixture\n");
    const index = git(old.root, "rev-parse", "--git-path", "index");
    const beforeIndex = readFileSync(index);
    const next = await prepareDraftReconciliation({
      ...input,
      previousCandidate: old,
      replayPreviousCandidate: true,
    });
    expect(next.root).not.toBe(old.root);
    expect(next.preservedCandidateRoot).toBe(old.root);
    expect(next.replayedAppChanges).toBe(true);
    expect(readFileSync(path.join(next.root, "apps/demo/tests/journey.spec.ts"), "utf-8")).toBe(
      "main\ndraft repaired\n",
    );
    expect(readFileSync(path.join(next.root, "apps/demo/repair.ts"), "utf-8")).toBe(
      "app-owned repair\n",
    );
    expect(git(next.root, "ls-files", "--stage", "apps/demo/repair.ts")).toMatch(/^100755/u);
    expect(
      readFileSync(path.join(next.root, "apps/demo/file-to-directory/child.ts"), "utf-8"),
    ).toBe("replacement child\n");
    expect(lstatSync(path.join(next.root, "apps/demo/directory-to-file")).isFile()).toBe(true);
    expect(readFileSync(path.join(next.root, "apps/demo/directory-to-file"), "utf-8")).toBe(
      "replacement file\n",
    );
    expect(existsSync(path.join(next.root, "apps/demo/rename-source.ts"))).toBe(false);
    expect(readFileSync(path.join(next.root, "apps/demo/rename-target.ts"), "utf-8")).toBe(
      "renamed app repair\n",
    );
    expect(git(next.root, "ls-files", "--stage", "apps/demo/rename-target.ts")).toMatch(/^100755/u);
    expect(existsSync(path.join(next.root, "apps/demo/obsolete.txt"))).toBe(false);
    expect(existsSync(path.join(next.root, "apps/demo/.env"))).toBe(false);
    expect(existsSync(path.join(next.root, "bun.lock"))).toBe(false);
    expect(readFileSync(path.join(next.root, "docs/platform.md"), "utf-8")).toBe("main\n");
    expect(readFileSync(path.join(old.root, "bun.lock"), "utf-8")).toBe("observed root metadata\n");
    expect(readFileSync(path.join(old.root, "docs/platform.md"), "utf-8")).toBe(
      "private outside-scope edit\n",
    );
    expect(readFileSync(index)).toEqual(beforeIndex);
    expect(next.conflicts).toEqual([]);
    await expect(
      inspectDraftReconciliation({ sandbox: f.sandbox, prepared: next }),
    ).resolves.toMatchObject({ unresolvedConflicts: [] });
  });

  it("preserves unresolved app stages and bytes in a fresh candidate", async () => {
    const f = fixture();
    const input = {
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha: f.headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    };
    const old = await prepareDraftReconciliation(input);
    const unmerged = git(old.root, "ls-files", "--unmerged");
    const conflict = readFileSync(path.join(old.root, "apps/demo/tests/journey.spec.ts"));
    writeFileSync(path.join(old.root, "bun.lock"), "outside-scope metadata\n");
    const next = await prepareDraftReconciliation({
      ...input,
      previousCandidate: old,
      replayPreviousCandidate: true,
    });
    expect(next.conflicts).toContain("apps/demo/tests/journey.spec.ts");
    expect(git(next.root, "ls-files", "--unmerged")).toBe(unmerged);
    expect(git(old.root, "ls-files", "--unmerged")).toBe(unmerged);
    expect(readFileSync(path.join(next.root, "apps/demo/tests/journey.spec.ts"))).toEqual(conflict);
    expect(readFileSync(path.join(old.root, "apps/demo/tests/journey.spec.ts"))).toEqual(conflict);
    expect(existsSync(path.join(next.root, "bun.lock"))).toBe(false);
  });

  it("three-way replays private app repairs when the live base advances", async () => {
    const f = fixture();
    const input = {
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha: f.headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    };
    const old = await prepareDraftReconciliation(input);
    await writeDraftReconciliationResolution({
      content: "old app repair\n",
      path: "apps/demo/tests/journey.spec.ts",
      prepared: old,
      sandbox: f.sandbox,
    });
    await inspectDraftReconciliation({ sandbox: f.sandbox, prepared: old });
    const oldIndexPath = git(old.root, "rev-parse", "--git-path", "index");
    const beforeIndex = readFileSync(oldIndexPath);
    const oldHead = git(old.root, "rev-parse", "HEAD");
    const archive = "apps/demo/schema/release/private-repair/artifact.json";
    mkdirSync(path.dirname(path.join(old.root, archive)), { recursive: true });
    writeFileSync(path.join(old.root, archive), "private archive\n");
    const checkout = path.join(f.root, "repository");
    git(checkout, "switch", "main");
    writeFileSync(path.join(checkout, "docs/platform.md"), "new live base\n");
    git(checkout, "add", "docs/platform.md");
    git(
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "main moves again",
    );
    const baseSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "push", "origin", "main");
    const next = await prepareDraftReconciliation({
      ...input,
      baseSha,
      previousCandidate: old,
      replayPreviousCandidate: true,
    });
    expect(next.root).not.toBe(old.root);
    expect(next.preservedCandidateRoot).toBe(old.root);
    expect(readFileSync(path.join(next.root, archive), "utf-8")).toBe("private archive\n");
    expect(readFileSync(path.join(old.root, archive), "utf-8")).toBe("private archive\n");
    expect(readFileSync(oldIndexPath)).toEqual(beforeIndex);
    expect(git(old.root, "rev-parse", "HEAD")).toBe(oldHead);
    expect(git(next.root, "rev-parse", "HEAD")).toBe(f.headSha);
    expect(next.baseSha).toBe(baseSha);
    expect(next.replayedAppChanges).toBe(true);
    expect(next.conflicts).toEqual([]);
    expect(readFileSync(path.join(next.root, "apps/demo/tests/journey.spec.ts"), "utf-8")).toBe(
      "old app repair\n",
    );
    expect(readFileSync(path.join(next.root, "docs/platform.md"), "utf-8")).toBe("new live base\n");
    expect(readFileSync(path.join(old.root, "apps/demo/tests/journey.spec.ts"), "utf-8")).toBe(
      "old app repair\n",
    );
  });

  it("three-way merges disjoint app edits while retaining new upstream archives", async () => {
    const f = fixture();
    const file = "apps/demo/shared.txt";
    const before = "first\nsecond\nthird\nfourth\nfifth\nsixth\n";
    const oldBase = advanceFixtureBase(f, { [file]: before });
    const input = candidateFixtureInput(f, oldBase);
    const old = await prepareDraftReconciliation(input);
    await writeDraftReconciliationResolution({
      prepared: old,
      sandbox: f.sandbox,
      path: "apps/demo/tests/journey.spec.ts",
      content: "resolved draft\n",
    });
    await inspectDraftReconciliation({ prepared: old, sandbox: f.sandbox });
    writeFileSync(path.join(old.root, file), before.replace("first", "private-first"));
    const incomingArchive = "apps/demo/schema/release/upstream/artifact.json";
    const baseSha = advanceFixtureBase(f, {
      [file]: before.replace("sixth", "upstream-sixth"),
      [incomingArchive]: "upstream archive\n",
    });
    const next = await prepareDraftReconciliation({
      ...input,
      baseSha,
      previousCandidate: old,
      replayPreviousCandidate: true,
    });
    expect(next.conflicts).toEqual([]);
    expect(readFileSync(path.join(next.root, file), "utf-8")).toBe(
      before.replace("first", "private-first").replace("sixth", "upstream-sixth"),
    );
    expect(readFileSync(path.join(next.root, incomingArchive), "utf-8")).toBe("upstream archive\n");
    expect(readFileSync(path.join(old.root, file), "utf-8")).toBe(
      before.replace("first", "private-first"),
    );
  });

  it("three-way retains renamed executable and binary files through file-directory replacements", async () => {
    const f = fixture();
    const oldBase = advanceFixtureBase(f, {
      "apps/demo/rename.ts": "original\n",
      "apps/demo/file-to-directory": "old file\n",
      "apps/demo/directory-to-file/nested/leaf.ts": "old leaf\n",
      "apps/demo/obsolete.ts": "obsolete\n",
    });
    const input = candidateFixtureInput(f, oldBase);
    const old = await prepareDraftReconciliation(input);
    await writeDraftReconciliationResolution({
      prepared: old,
      sandbox: f.sandbox,
      path: "apps/demo/tests/journey.spec.ts",
      content: "resolved draft\n",
    });
    await inspectDraftReconciliation({ prepared: old, sandbox: f.sandbox });
    git(old.root, "mv", "apps/demo/rename.ts", "apps/demo/renamed.ts");
    chmodSync(path.join(old.root, "apps/demo/renamed.ts"), 0o755);
    rmSync(path.join(old.root, "apps/demo/file-to-directory"));
    mkdirSync(path.join(old.root, "apps/demo/file-to-directory"));
    writeFileSync(path.join(old.root, "apps/demo/file-to-directory/child.ts"), "new child\n");
    rmSync(path.join(old.root, "apps/demo/directory-to-file"), { recursive: true });
    writeFileSync(path.join(old.root, "apps/demo/directory-to-file"), "new file\n");
    rmSync(path.join(old.root, "apps/demo/obsolete.ts"));
    const binary = Buffer.from([0, 255, 128, 10, 13, 0]);
    writeFileSync(path.join(old.root, "apps/demo/private.bin"), binary);
    const baseSha = advanceFixtureBase(f, { "apps/demo/rename.ts": "upstream update\n" });
    const next = await prepareDraftReconciliation({
      ...input,
      baseSha,
      previousCandidate: old,
      replayPreviousCandidate: true,
    });
    expect(next.conflicts).toEqual([]);
    expect(existsSync(path.join(next.root, "apps/demo/rename.ts"))).toBe(false);
    expect(readFileSync(path.join(next.root, "apps/demo/renamed.ts"), "utf-8")).toBe(
      "upstream update\n",
    );
    expect(git(next.root, "ls-files", "--stage", "apps/demo/renamed.ts")).toMatch(/^100755/u);
    expect(
      readFileSync(path.join(next.root, "apps/demo/file-to-directory/child.ts"), "utf-8"),
    ).toBe("new child\n");
    expect(readFileSync(path.join(next.root, "apps/demo/directory-to-file"), "utf-8")).toBe(
      "new file\n",
    );
    expect(existsSync(path.join(next.root, "apps/demo/obsolete.ts"))).toBe(false);
    expect(readFileSync(path.join(next.root, "apps/demo/private.bin"))).toEqual(binary);
    expect(readFileSync(path.join(old.root, "apps/demo/renamed.ts"), "utf-8")).toBe("original\n");
  });

  it.each(["edit", "delete", "add"] as const)(
    "three-way preserves ordinary %s conflicts against the advanced app base",
    async (kind) => {
      const f = fixture();
      const file = "apps/demo/shared.txt";
      const oldBase = kind === "add" ? f.baseSha : advanceFixtureBase(f, { [file]: "original\n" });
      const input = candidateFixtureInput(f, oldBase);
      const old = await prepareDraftReconciliation(input);
      await writeDraftReconciliationResolution({
        prepared: old,
        sandbox: f.sandbox,
        path: "apps/demo/tests/journey.spec.ts",
        content: "resolved draft\n",
      });
      await inspectDraftReconciliation({ prepared: old, sandbox: f.sandbox });
      if (kind === "delete") {
        rmSync(path.join(old.root, file));
      } else {
        writeFileSync(path.join(old.root, file), "private\n");
      }
      const indexPath = git(old.root, "rev-parse", "--git-path", "index");
      const oldIndex = readFileSync(indexPath);
      const baseSha = advanceFixtureBase(f, { [file]: "upstream\n" });
      const next = await prepareDraftReconciliation({
        ...input,
        baseSha,
        previousCandidate: old,
        replayPreviousCandidate: true,
      });
      expect(next.conflicts).toContain(file);
      expect(git(next.root, "show", `:3:${file}`)).toBe("upstream");
      if (kind !== "delete") {
        expect(git(next.root, "show", `:2:${file}`)).toBe("private");
      }
      if (kind !== "add") {
        expect(git(next.root, "show", `:1:${file}`)).toBe("original");
      }
      expect(readFileSync(indexPath)).toEqual(oldIndex);
      if (kind === "delete") {
        expect(existsSync(path.join(old.root, file))).toBe(false);
      } else {
        expect(readFileSync(path.join(old.root, file), "utf-8")).toBe("private\n");
      }
    },
  );

  it.each([false, true])(
    "three-way keeps old unresolved work unresolved when upstream path changes: %s",
    async (changed) => {
      const f = fixture();
      const input = candidateFixtureInput(f);
      const old = await prepareDraftReconciliation(input);
      const file = "apps/demo/tests/journey.spec.ts";
      const original = readFileSync(path.join(old.root, file));
      const oldStages = git(old.root, "ls-files", "--unmerged");
      const indexPath = git(old.root, "rev-parse", "--git-path", "index");
      const oldIndex = readFileSync(indexPath);
      const baseSha = advanceFixtureBase(
        f,
        changed ? { [file]: "new upstream\n" } : { "docs/platform.md": "advanced platform\n" },
      );
      const next = await prepareDraftReconciliation({
        ...input,
        baseSha,
        previousCandidate: old,
        replayPreviousCandidate: true,
      });
      expect(next.conflicts).toContain(file);
      expect(readFileSync(path.join(old.root, file))).toEqual(original);
      expect(readFileSync(indexPath)).toEqual(oldIndex);
      expect(git(old.root, "ls-files", "--unmerged")).toBe(oldStages);
      if (changed) {
        expect(git(next.root, "show", `:3:${file}`)).toBe("new upstream");
      } else {
        expect(git(next.root, "ls-files", "--unmerged")).toBe(oldStages);
        expect(readFileSync(path.join(next.root, file))).toEqual(original);
      }
    },
  );

  it("three-way base refresh leaves ignored private bytes and outside-app changes in the old candidate", async () => {
    const f = fixture();
    const input = candidateFixtureInput(f);
    const old = await prepareDraftReconciliation(input);
    const checkout = path.join(f.root, "repository");
    writeFileSync(path.join(checkout, ".git/info/exclude"), "apps/demo/private-state/\n");
    mkdirSync(path.join(old.root, "apps/demo/private-state"));
    writeFileSync(path.join(old.root, "apps/demo/private-state/session"), "private fixture\n");
    writeFileSync(path.join(old.root, "docs/platform.md"), "private outside-app edit\n");
    git(old.root, "add", "docs/platform.md");
    const indexPath = git(old.root, "rev-parse", "--git-path", "index");
    const oldIndex = readFileSync(indexPath);
    const baseSha = advanceFixtureBase(f, { "docs/platform.md": "advanced platform\n" });
    const next = await prepareDraftReconciliation({
      ...input,
      baseSha,
      previousCandidate: old,
      replayPreviousCandidate: true,
    });
    expect(readFileSync(path.join(next.root, "docs/platform.md"), "utf-8")).toBe(
      "advanced platform\n",
    );
    expect(existsSync(path.join(next.root, "apps/demo/private-state"))).toBe(false);
    expect(readFileSync(path.join(old.root, "apps/demo/private-state/session"), "utf-8")).toBe(
      "private fixture\n",
    );
    expect(readFileSync(path.join(old.root, "docs/platform.md"), "utf-8")).toBe(
      "private outside-app edit\n",
    );
    expect(readFileSync(indexPath)).toEqual(oldIndex);
  });

  it("three-way preserves owned dependency links attached to both old and fresh candidates", async () => {
    const f = fixture();
    const checkout = path.join(f.root, "repository");
    mkdirSync(path.join(checkout, "apps/demo/node_modules/fixture-package"), { recursive: true });
    writeFileSync(
      path.join(checkout, "apps/demo/node_modules/fixture-package/package.json"),
      '{"name":"fixture-package"}',
    );
    const input = candidateFixtureInput(f);
    const old = await prepareDraftReconciliation(input);
    expect(lstatSync(path.join(old.root, "apps/demo/node_modules")).isSymbolicLink()).toBe(true);
    expect(
      git(old.root, "ls-files", "--others", "--exclude-standard", "--", "apps/demo/node_modules"),
    ).toBe("apps/demo/node_modules");
    const baseSha = advanceFixtureBase(f, { "docs/platform.md": "advanced platform\n" });
    const originalRun = f.sandbox.run.bind(f.sandbox);
    const attached = new Set([old.root]);
    const sandbox = {
      ...f.sandbox,
      async run(command: Parameters<SandboxSession["run"]>[0]) {
        const result = await originalRun(command);
        for (const line of git(checkout, "worktree", "list", "--porcelain").split("\n")) {
          if (!line.startsWith("worktree ")) {
            continue;
          }
          const reportedRoot = line.slice("worktree ".length);
          const relative = path.relative(realpathSync(f.root), realpathSync(reportedRoot));
          if (!relative.startsWith(".app-builder/draft-reconcile/")) {
            continue;
          }
          const root = path.join(f.root, relative);
          if (attached.has(root)) {
            continue;
          }
          const view = path.join(
            realpathSync(f.root),
            ".app-builder/dependency-views/checkout",
            digest(root),
            "apps/demo/node_modules",
          );
          mkdirSync(view, { recursive: true });
          symlinkSync(view, path.join(root, "apps/demo/node_modules"));
          attached.add(root);
        }
        return result;
      },
    };
    const next = await prepareDraftReconciliation({
      ...input,
      sandbox,
      baseSha,
      previousCandidate: old,
      replayPreviousCandidate: true,
    });
    expect(attached.has(next.root)).toBe(true);
    for (const root of [old.root, next.root]) {
      expect(lstatSync(path.join(root, "apps/demo/node_modules")).isSymbolicLink()).toBe(true);
      expect(
        readFileSync(
          path.join(root, "apps/demo/node_modules/fixture-package/package.json"),
          "utf-8",
        ),
      ).toBe('{"name":"fixture-package"}');
    }
  });

  it("three-way base refresh rebuilds an unavailable candidate without claiming to replay its lost files", async () => {
    const f = fixture();
    const input = candidateFixtureInput(f);
    const old = await prepareDraftReconciliation(input);
    git(path.join(f.root, "repository"), "worktree", "remove", "--force", old.root);
    const baseSha = advanceFixtureBase(f, { "docs/platform.md": "advanced platform\n" });
    const next = await prepareDraftReconciliation({
      ...input,
      baseSha,
      previousCandidate: old,
      replayPreviousCandidate: true,
    });
    expect(next.replayedAppChanges).not.toBe(true);
    expect(next.preservedCandidateRoot).toBeUndefined();
    expect(readFileSync(path.join(next.root, "docs/platform.md"), "utf-8")).toBe(
      "advanced platform\n",
    );
  });

  it("blocks unsafe app replay without deleting the original candidate", async () => {
    const f = fixture();
    const input = {
      appId: "demo",
      baseBranch: "main",
      baseSha: f.baseSha,
      headBranch: "draft",
      headSha: f.headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox: f.sandbox,
      workspaceRoot: f.root,
    };
    const old = await prepareDraftReconciliation(input);
    writeFileSync(path.join(old.root, "bun.lock"), "outside-scope metadata\n");
    const external = path.join(f.root, "private-fixture");
    writeFileSync(external, "private fixture bytes\n");
    symlinkSync(external, path.join(old.root, "apps/demo/unsafe"));
    await expect(
      prepareDraftReconciliation({
        ...input,
        previousCandidate: old,
        replayPreviousCandidate: true,
      }),
    ).rejects.toThrow("could not preserve every app repair");
    expect(lstatSync(path.join(old.root, "apps/demo/unsafe")).isSymbolicLink()).toBe(true);
    expect(readFileSync(external, "utf-8")).toBe("private fixture bytes\n");
    expect(readFileSync(path.join(old.root, "bun.lock"), "utf-8")).toBe("outside-scope metadata\n");
  });

  it("reports a lost private candidate and rebuilds it without carrying old resolutions", async () => {
    const { root, sandbox, headSha, baseSha } = fixture();
    const input = {
      appId: "demo",
      baseBranch: "main",
      baseSha,
      headBranch: "draft",
      headSha,
      repository: { name: "arrusted-development", owner: "withAutograph" },
      sandbox,
      workspaceRoot: root,
    };
    const prepared = await prepareDraftReconciliation(input);
    expect(prepared.created).toBe(true);
    await writeDraftReconciliationResolution({
      content: "old uncommitted resolution\n",
      path: "apps/demo/tests/journey.spec.ts",
      prepared,
      sandbox,
    });
    rmSync(prepared.root, { force: true, recursive: true });
    git(path.join(root, "repository"), "worktree", "prune");
    await expect(inspectDraftReconciliation({ prepared, sandbox })).rejects.toThrow(
      "private draft merge candidate is no longer in this sandbox",
    );
    const rebuilt = await prepareDraftReconciliation(input);
    expect(rebuilt.created).toBe(true);
    expect(rebuilt.conflicts).toEqual(["apps/demo/tests/journey.spec.ts"]);
    expect(
      await readDraftReconciliationConflict({
        path: "apps/demo/tests/journey.spec.ts",
        prepared: rebuilt,
        sandbox,
      }),
    ).toContain("<<<<<<<");
    expect(
      await readDraftReconciliationConflict({
        path: "apps/demo/tests/journey.spec.ts",
        prepared: rebuilt,
        sandbox,
      }),
    ).not.toContain("old uncommitted resolution");
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

describe("unused draft worktree retirement", () => {
  const registeredFixture = () => {
    const f = fixture();
    const workspaceRoot = realpathSync(f.root);
    const checkout = path.join(workspaceRoot, "repository");
    const root = path.join(workspaceRoot, ".app-builder/draft-reconcile/previous");
    mkdirSync(path.dirname(root), { recursive: true });
    git(checkout, "worktree", "add", "--detach", root, f.headSha);
    return { ...f, workspaceRoot, checkout, retiredRoot: root };
  };
  const retire = async (f: ReturnType<typeof registeredFixture>, retainedRoots: string[] = []) =>
    await retireUnusedDraftWorktrees({
      sandbox: f.sandbox,
      workspaceRoot: f.workspaceRoot,
      retainedRoots,
    });
  const attachDependencies = async (f: ReturnType<typeof registeredFixture>, ignored = false) => {
    git(f.checkout, "config", "core.excludesFile", "/dev/null");
    if (ignored) {
      writeFileSync(path.join(f.checkout, ".git/info/exclude"), "node_modules\n");
    }
    const roots = ["node_modules", "apps/demo/node_modules"];
    for (const relative of roots) {
      const source = path.join(f.checkout, relative, "fixture-package");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "private-cache"), "external dependency bytes\n");
    }
    await attachCheckoutDependencyView({
      sandbox: f.sandbox,
      checkoutRoot: f.checkout,
      candidateRoot: f.retiredRoot,
      workspaceRoot: f.workspaceRoot,
    });
    return roots.map((relative) => {
      const link = path.join(f.retiredRoot, relative);
      return { link, target: readlinkSync(link) };
    });
  };
  const retireWithFault = async (
    f: ReturnType<typeof registeredFixture>,
    fault: string,
    setup = "",
  ) => {
    const preload = path.join(f.workspaceRoot, "derived-link-fault.cjs");
    writeFileSync(
      preload,
      `const cp = require("node:child_process");
const fs = require("node:fs");
const original = cp.spawn;
let statuses = 0;
let references = 0;
${setup}
cp.spawn = (command, args, options) => {
  ${fault}
  return original(command, args, options);
};`,
    );
    return await retireUnusedDraftWorktrees({
      workspaceRoot: f.workspaceRoot,
      retainedRoots: [],
      sandbox: {
        run(input) {
          const result = spawnSync("/bin/sh", ["-c", input.command], {
            cwd: f.workspaceRoot,
            encoding: "utf-8",
            env: {
              ...process.env,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              HOME: f.workspaceRoot,
              NODE_OPTIONS: `--require ${preload}`,
              PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            },
          });
          return Promise.resolve({
            exitCode: result.status ?? 1,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        },
      },
    });
  };

  it("reports clean retirement and known private or referenced retention without changing eligibility", async () => {
    const f = registeredFixture();
    const referenced = path.join(path.dirname(f.retiredRoot), "referenced");
    const privateRoot = path.join(path.dirname(f.retiredRoot), "private");
    git(f.checkout, "worktree", "add", "--detach", referenced, f.headSha);
    git(f.checkout, "worktree", "add", "--detach", privateRoot, f.headSha);
    writeFileSync(path.join(privateRoot, "owner-record"), "private retained bytes\n");
    const result = await retire(f, [referenced]);
    expect(result).toMatchObject({
      status: "complete",
      retired: 1,
      retained: 2,
      reasons: { referenced: 1, private_state: 1 },
    });
    expect(existsSync(f.retiredRoot)).toBe(false);
    expect(existsSync(referenced)).toBe(true);
    expect(readFileSync(path.join(privateRoot, "owner-record"), "utf-8")).toBe(
      "private retained bytes\n",
    );
    expect(JSON.stringify(result)).not.toContain(f.workspaceRoot);
    expect(JSON.stringify(result)).not.toContain("owner-record");
    expect(JSON.stringify(result)).not.toContain("private retained bytes");
  });

  it("reports known zero free bytes and inodes as decimal capacity rather than unknown", async () => {
    const f = registeredFixture();
    const result = await retireWithFault(
      f,
      "",
      `fs.statfsSync = () => ({ bsize: 4096n, blocks: 1024n, bavail: 0n, files: 512n, ffree: 0n });`,
    );
    expect(result).toMatchObject({ status: "complete", retired: 1, retained: 0 });
    expect(result.capacity?.before).toEqual({
      bytes: { total: "4194304", available: "0" },
      inodes: { total: "512", free: "0" },
    });
    expect(result.capacity?.after).toEqual(result.capacity?.before);
  });

  it.each(["unsupported inodes", "statfs unavailable"])(
    "keeps cleanup usable with %s",
    async (kind) => {
      const f = registeredFixture();
      const result = await retireWithFault(
        f,
        "",
        kind === "unsupported inodes"
          ? `fs.statfsSync = () => ({ bsize: 4096n, blocks: 1024n, bavail: 7n, files: 0n, ffree: 0n });`
          : `fs.statfsSync = () => { throw Error("private statfs details"); };`,
      );
      expect(result).toMatchObject({ status: "complete", retired: 1, retained: 0 });
      expect(result.capacity?.before?.inodes).toBeUndefined();
      if (kind === "unsupported inodes") {
        expect(result.capacity?.before?.bytes).toEqual({ total: "4194304", available: "28672" });
      } else {
        expect(result.capacity?.before?.bytes).toBeUndefined();
      }
      expect(existsSync(f.retiredRoot)).toBe(false);
      expect(JSON.stringify(result)).not.toContain("private statfs details");
    },
  );

  it("reports unknown Git inspection as partial and preserves the exact worktree", async () => {
    const f = registeredFixture();
    const result = await retireWithFault(
      f,
      `if (args.includes("status")) return original(process.execPath, ["-e", "process.exit(1)"], options);`,
    );
    expect(result).toMatchObject({
      status: "partial",
      retired: 0,
      retained: 1,
      reasons: { inspection_unavailable: 1 },
    });
    expect(existsSync(f.retiredRoot)).toBe(true);
    expect(git(f.retiredRoot, "rev-parse", "HEAD")).toBe(f.headSha);
  });

  it.each([
    { exitCode: 1, stdout: "private command output", stderr: "private failure" },
    { exitCode: 0, stdout: "not JSON private payload", stderr: "" },
    {
      exitCode: 0,
      stdout: JSON.stringify({ status: "complete", retired: -1, retained: 0, reasons: {} }),
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: JSON.stringify({
        status: "complete",
        retired: 0,
        retained: 0,
        reasons: { "private path": 1 },
      }),
      stderr: "",
    },
  ])(
    "returns unavailable for an untrusted cleanup response %# without exposing command details",
    async (response) => {
      const run = vi.fn<SandboxSession["run"]>().mockResolvedValue(response);
      const result = await retireUnusedDraftWorktrees({ sandbox: { run }, retainedRoots: [] });
      expect(result).toEqual({ status: "unavailable", retired: 0, retained: 0, reasons: {} });
      expect(run).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it("preserves cancellation instead of replacing it with an unavailable advisory", async () => {
    const controller = new AbortController();
    const cancellation = new DOMException("Controlled stop", "AbortError");
    controller.abort(cancellation);
    await expect(
      retireUnusedDraftWorktrees({
        sandbox: { run: () => Promise.reject(cancellation) },
        retainedRoots: [],
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);
  });

  it.each([false, true])(
    "retires attached dependency links (ignored=%s) without touching their external bytes",
    async (ignored) => {
      const f = registeredFixture();
      const links = await attachDependencies(f, ignored);
      await retire(f);
      expect(existsSync(f.retiredRoot)).toBe(false);
      expect(git(f.checkout, "worktree", "list", "--porcelain")).not.toContain(f.retiredRoot);
      for (const { target } of links) {
        expect(readFileSync(path.join(target, "fixture-package/private-cache"), "utf-8")).toBe(
          "external dependency bytes\n",
        );
      }
      const ref = `refs/app-builder/retired-draft-worktrees/${digest(f.retiredRoot)}`;
      expect(git(f.checkout, "rev-parse", ref)).toBe(f.headSha);
    },
  );

  it.each([
    "referenced",
    "private sibling",
    "real dependencies",
    "foreign link",
    "wrong candidate",
    "wrong relative",
    "tracked link",
  ])("retains %s alongside an attached dependency view", async (kind) => {
    const f = registeredFixture();
    const links = await attachDependencies(f, true);
    const selected = links[0];
    if (selected === undefined) {
      throw new Error("Missing fixture dependency link");
    }
    if (kind === "private sibling") {
      writeFileSync(path.join(f.retiredRoot, "private-record"), "private bytes\n");
      writeFileSync(path.join(f.checkout, ".git/info/exclude"), "node_modules\nprivate-record\n");
    } else if (kind !== "referenced") {
      rmSync(selected.link);
      if (kind === "real dependencies") {
        mkdirSync(selected.link);
        writeFileSync(path.join(selected.link, "private-record"), "private bytes\n");
      } else {
        let target = f.checkout;
        if (kind === "wrong candidate") {
          target = selected.target.replace(digest(f.retiredRoot), digest("different candidate"));
        } else if (kind === "wrong relative") {
          target = path.join(selected.target, "nested/node_modules");
        } else if (kind === "tracked link") {
          symlinkSync(target, selected.link);
          git(f.retiredRoot, "add", "--force", "node_modules");
          git(
            f.retiredRoot,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-m",
            "tracked link",
          );
          rmSync(selected.link);
          target = selected.target;
        }
        symlinkSync(target, selected.link);
      }
    }
    await retire(f, kind === "referenced" ? [f.retiredRoot] : []);
    expect(existsSync(f.retiredRoot)).toBe(true);
    expect(readlinkSync(path.join(f.retiredRoot, "apps/demo/node_modules"))).toBe(links[1]?.target);
    expect(readFileSync(path.join(selected.target, "fixture-package/private-cache"), "utf-8")).toBe(
      "external dependency bytes\n",
    );
    if (kind === "real dependencies") {
      expect(readFileSync(path.join(selected.link, "private-record"), "utf-8")).toBe(
        "private bytes\n",
      );
    }
    if (kind === "private sibling") {
      expect(readFileSync(path.join(f.retiredRoot, "private-record"), "utf-8")).toBe(
        "private bytes\n",
      );
    }
  });

  it("retains a foreign-owned symlink even when its target matches the derived convention", async () => {
    const f = registeredFixture();
    const links = await attachDependencies(f);
    const link = path.join(f.retiredRoot, "node_modules");
    await retireWithFault(
      f,
      "",
      `const originalLstat = fs.lstatSync;
fs.lstatSync = (...args) => {
  const stat = originalLstat(...args);
  if (args[0] === ${JSON.stringify(link)} && stat) stat.uid = process.getuid() + 1;
  return stat;
};`,
    );
    expect(existsSync(f.retiredRoot)).toBe(true);
    expect(readlinkSync(link)).toBe(links[0]?.target);
  });

  it("restores detached links when unforced Git removal fails", async () => {
    const f = registeredFixture();
    const links = await attachDependencies(f);
    await retireWithFault(
      f,
      `if (args.includes("remove")) return original(process.execPath, ["-e", "process.exit(1)"], options);`,
    );
    expect(existsSync(f.retiredRoot)).toBe(true);
    for (const { link, target } of links) {
      expect(readlinkSync(link)).toBe(target);
      expect(readFileSync(path.join(target, "fixture-package/private-cache"), "utf-8")).toBe(
        "external dependency bytes\n",
      );
    }
  });

  it("does not overwrite replacement private bytes while restoring after detachment", async () => {
    const f = registeredFixture();
    const links = await attachDependencies(f, true);
    const link = path.join(f.retiredRoot, "node_modules");
    await retireWithFault(
      f,
      `if (args.includes("status") && ++statuses === 3) fs.writeFileSync(${JSON.stringify(link)}, "replacement private bytes");`,
    );
    expect(readFileSync(link, "utf-8")).toBe("replacement private bytes");
    expect(readlinkSync(path.join(f.retiredRoot, "apps/demo/node_modules"))).toBe(links[1]?.target);
  });

  it("retains a dependency link replaced by a private directory before detachment", async () => {
    const f = registeredFixture();
    await attachDependencies(f, true);
    const link = path.join(f.retiredRoot, "node_modules");
    await retireWithFault(
      f,
      `if (args.includes("update-ref")) {
      const child = original(command, args, options);
      child.on("close", () => { fs.unlinkSync(${JSON.stringify(link)}); fs.mkdirSync(${JSON.stringify(link)}); fs.writeFileSync(${JSON.stringify(path.join(link, "private-record"))}, "replacement private bytes"); });
      return child;
    }`,
    );
    expect(readFileSync(path.join(link, "private-record"), "utf-8")).toBe(
      "replacement private bytes",
    );
  });

  it("does not unlink through a parent replaced after inspection", async () => {
    const f = registeredFixture();
    await attachDependencies(f, true);
    const parent = path.join(f.retiredRoot, "apps/demo");
    const foreign = path.join(f.workspaceRoot, "foreign-parent");
    mkdirSync(foreign);
    const foreignLink = path.join(foreign, "node_modules");
    symlinkSync(f.checkout, foreignLink);
    await retireWithFault(
      f,
      `if (args.includes("rev-parse") && args.includes("--quiet") && ++references === 2) {
      const child = original(command, args, options);
      child.on("close", () => { fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(`${parent}-preserved`)}); fs.symlinkSync(${JSON.stringify(foreign)}, ${JSON.stringify(parent)}); });
      return child;
    }`,
    );
    expect(readlinkSync(foreignLink)).toBe(f.checkout);
    expect(lstatSync(parent).isSymbolicLink()).toBe(true);
    expect(existsSync(`${parent}-preserved/tests/journey.spec.ts`)).toBe(true);
  });

  it("retires a clean registered checkout while retaining its detached private commit", async () => {
    const f = registeredFixture();
    writeFileSync(
      path.join(f.retiredRoot, "apps/demo/tests/journey.spec.ts"),
      "local committed repair\n",
    );
    git(f.retiredRoot, "add", ".");
    git(
      f.retiredRoot,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "private repair",
    );
    const head = git(f.retiredRoot, "rev-parse", "HEAD");
    await retire(f);
    expect(existsSync(f.retiredRoot)).toBe(false);
    const ref = `refs/app-builder/retired-draft-worktrees/${digest(f.retiredRoot)}`;
    expect(git(f.checkout, "rev-parse", ref)).toBe(head);
    expect(git(f.checkout, "show", `${ref}:apps/demo/tests/journey.spec.ts`)).toBe(
      "local committed repair",
    );
    expect(git(f.checkout, "worktree", "list", "--porcelain")).not.toContain(f.retiredRoot);
    expect(existsSync(f.checkout)).toBe(true);
  });

  it.each(["tracked", "staged", "untracked", "ignored", "empty directory", "assume unchanged"])(
    "retains unique %s state",
    async (kind) => {
      const f = registeredFixture();
      const tracked = path.join(f.retiredRoot, "apps/demo/tests/journey.spec.ts");
      if (kind === "tracked" || kind === "staged" || kind === "assume unchanged") {
        writeFileSync(tracked, "private repair\n");
        if (kind === "staged") {
          git(f.retiredRoot, "add", ".");
        }
        if (kind === "assume unchanged") {
          git(
            f.retiredRoot,
            "update-index",
            "--assume-unchanged",
            "apps/demo/tests/journey.spec.ts",
          );
        }
      } else if (kind === "empty directory") {
        mkdirSync(path.join(f.retiredRoot, "private-empty"));
      } else {
        writeFileSync(path.join(f.retiredRoot, "private-record"), "private bytes\n");
        if (kind === "ignored") {
          writeFileSync(path.join(f.checkout, ".git/info/exclude"), "private-record\n");
        }
      }
      await retire(f);
      expect(existsSync(f.retiredRoot)).toBe(true);
      if (kind === "tracked" || kind === "staged" || kind === "assume unchanged") {
        expect(readFileSync(tracked, "utf-8")).toBe("private repair\n");
      } else if (kind !== "empty directory") {
        expect(readFileSync(path.join(f.retiredRoot, "private-record"), "utf-8")).toBe(
          "private bytes\n",
        );
      }
    },
  );

  it("retains unresolved index stages", async () => {
    const f = registeredFixture();
    const trackedPath = "apps/demo/tests/journey.spec.ts";
    const hash = git(f.retiredRoot, "rev-parse", `HEAD:${trackedPath}`);
    git(f.retiredRoot, "update-index", "--force-remove", trackedPath);
    // oxlint-disable-next-line sonarjs/no-os-command-from-path -- Git creates unresolved stages only in this temporary fixture.
    const result = spawnSync("git", ["-C", f.retiredRoot, "update-index", "--index-info"], {
      input: [1, 2, 3].map((stage) => `100644 ${hash} ${stage}\t${trackedPath}\n`).join(""),
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    const unresolved = git(f.retiredRoot, "ls-files", "--unmerged");
    expect(unresolved).not.toBe("");
    await retire(f);
    expect(existsSync(f.retiredRoot)).toBe(true);
    expect(git(f.retiredRoot, "ls-files", "--unmerged")).toBe(unresolved);
  });

  it.each(["exact", "parent", "child"])(
    "retains a referenced root with %s overlap",
    async (kind) => {
      const f = registeredFixture();
      let retained = f.retiredRoot;
      if (kind === "parent") {
        retained = path.dirname(f.retiredRoot);
      }
      if (kind === "child") {
        retained = path.join(f.retiredRoot, "apps/demo");
      }
      await retire(f, [retained]);
      expect(existsSync(f.retiredRoot)).toBe(true);
    },
  );

  it("retains a worktree whose private retention ref already names different history", async () => {
    const f = registeredFixture();
    const ref = `refs/app-builder/retired-draft-worktrees/${digest(f.retiredRoot)}`;
    git(f.checkout, "update-ref", ref, f.baseSha);
    await retire(f);
    expect(existsSync(f.retiredRoot)).toBe(true);
    expect(git(f.checkout, "rev-parse", ref)).toBe(f.baseSha);
  });

  it("retains symbolic retention refs and their target history", async () => {
    const f = registeredFixture();
    const ref = `refs/app-builder/retired-draft-worktrees/${digest(f.retiredRoot)}`;
    const target = "refs/app-builder/existing-history";
    git(f.checkout, "update-ref", target, f.headSha);
    git(f.checkout, "symbolic-ref", ref, target);
    await retire(f);
    expect(existsSync(f.retiredRoot)).toBe(true);
    expect(git(f.checkout, "symbolic-ref", ref)).toBe(target);
    expect(git(f.checkout, "rev-parse", target)).toBe(f.headSha);
  });

  it("retains a registered path whose Git common directory changed", async () => {
    const f = registeredFixture();
    const foreign = fixture();
    writeFileSync(
      path.join(f.retiredRoot, ".git"),
      `gitdir: ${path.join(foreign.root, "repository/.git")}\n`,
    );
    await retire(f);
    expect(existsSync(f.retiredRoot)).toBe(true);
    expect(git(path.join(foreign.root, "repository"), "rev-parse", "HEAD")).toBe(foreign.headSha);
  });

  it("does not touch an unregistered directory or a foreign repository", async () => {
    const f = registeredFixture();
    const foreign = fixture();
    const foreignRoot = path.join(path.dirname(f.retiredRoot), "foreign");
    git(
      path.join(foreign.root, "repository"),
      "worktree",
      "add",
      "--detach",
      foreignRoot,
      foreign.headSha,
    );
    const unknown = path.join(path.dirname(f.retiredRoot), "unknown");
    mkdirSync(unknown);
    writeFileSync(path.join(unknown, "private"), "unregistered bytes\n");
    await retire(f, [f.retiredRoot]);
    expect(existsSync(foreignRoot)).toBe(true);
    expect(readFileSync(path.join(unknown, "private"), "utf-8")).toBe("unregistered bytes\n");
  });

  it.each(["race", "ref failure", "remove failure"])(
    "retains on %s without overwriting private state",
    async (failure) => {
      const f = registeredFixture();
      const preload = path.join(f.workspaceRoot, "git-fault.cjs");
      writeFileSync(
        preload,
        `
const cp = require("node:child_process");
const fs = require("node:fs");
const original = cp.spawn;
cp.spawn = (command, args, options) => {
  if (command === "git" && args.includes("update-ref")) {
    if (${JSON.stringify(failure)} === "ref failure") return original(process.execPath, ["-e", "process.exit(1)"], options);
    const child = original(command, args, options);
    if (${JSON.stringify(failure)} === "race") child.on("close", () => fs.writeFileSync(${JSON.stringify(path.join(f.retiredRoot, "late-private"))}, "late bytes"));
    return child;
  }
  if (command === "git" && args.includes("remove") && ${JSON.stringify(failure)} === "remove failure") return original(process.execPath, ["-e", "process.exit(1)"], options);
  return original(command, args, options);
};
`,
      );
      await retireUnusedDraftWorktrees({
        workspaceRoot: f.workspaceRoot,
        retainedRoots: [],
        sandbox: {
          run(input) {
            const result = spawnSync("/bin/sh", ["-c", input.command], {
              cwd: f.workspaceRoot,
              encoding: "utf-8",
              env: {
                ...process.env,
                NODE_OPTIONS: `--require ${preload}`,
                PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
              },
            });
            return Promise.resolve({
              exitCode: result.status ?? 1,
              stdout: result.stdout,
              stderr: result.stderr,
            });
          },
        },
      });
      expect(existsSync(f.retiredRoot)).toBe(true);
      if (failure === "race") {
        expect(readFileSync(path.join(f.retiredRoot, "late-private"), "utf-8")).toBe("late bytes");
      }
    },
  );

  it("leaves an unknown provider outcome alone", async () => {
    const f = registeredFixture();
    await retireUnusedDraftWorktrees({
      workspaceRoot: f.workspaceRoot,
      retainedRoots: [],
      sandbox: { run: () => Promise.reject(new Error("unknown provider outcome")) },
    });
    expect(existsSync(f.retiredRoot)).toBe(true);
  });
});
