import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxSession } from "eve/sandbox";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectDraftReconciliation,
  prepareDraftReconciliation,
  readDraftReconciliationCandidateFile,
  readDraftReconciliationConflict,
  readDraftReconciliationDiff,
  replaceDraftReconciliationCandidateText,
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

describe("isolated draft reconciliation", () => {
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

  it("uses ordinary fresh reconciliation when the live base changes without replaying old resolutions", async () => {
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
    expect(next.baseSha).toBe(baseSha);
    expect(next.replayedAppChanges).toBe(false);
    expect(next.conflicts).toContain("apps/demo/tests/journey.spec.ts");
    expect(readFileSync(path.join(next.root, "docs/platform.md"), "utf-8")).toBe("new live base\n");
    expect(readFileSync(path.join(old.root, "apps/demo/tests/journey.spec.ts"), "utf-8")).toBe(
      "old app repair\n",
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
