import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readSandboxGitHubSourceSnapshot,
  sandboxGitHubSourceManifestProgram,
  writeSandboxGitHubSourceManifest,
} from "./sandbox-github-source";
/* oxlint-disable sonarjs/no-os-command-from-path -- Exercise Git only in a disposable repository fixture. */

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const expected = {
  repository: "https://github.com/acme/private.git",
  sourceSha: sha,
  sourceTree: tree,
};

describe("provider-created sandbox GitHub source", () => {
  it("reads the selected checkout without cloning it again", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(
      readSandboxGitHubSourceSnapshot({ run } as never, expected),
    ).resolves.toMatchObject({
      sourcePath: "/workspace/repository",
      sourceSha: sha,
      sourceTree: tree,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0].command).not.toContain("git clone");
  });

  it("moves a verified provider-created checkout into the Builder workspace", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      });
    await expect(
      readSandboxGitHubSourceSnapshot({ run } as never, expected),
    ).resolves.toMatchObject({ sourcePath: "/workspace/repository", sourceSha: sha });
    expect(run.mock.calls[2]?.[0].command).toContain("git -C '/workspace/private' rev-parse HEAD");
    expect(run.mock.calls[3]?.[0].command).toContain("renameSync");
    for (const call of run.mock.calls) {
      expect(call[0].command).not.toContain("git clone");
    }
  });

  it("uses the standard Vercel working directory when the Eve image path is absent", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      });
    await expect(
      readSandboxGitHubSourceSnapshot({ run } as never, expected),
    ).resolves.toMatchObject({ sourcePath: "/workspace/repository", sourceSha: sha });
    expect(run.mock.calls[3]?.[0].command).toContain("git -C '/vercel/sandbox' rev-parse HEAD");
    expect(run.mock.calls[4]?.[0].command).toContain("renameSync");
  });

  it("does not alter an occupied workspace that is not a Git checkout", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "occupied by a non-Git directory",
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports when Vercel did not create the selected Git checkout", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "Vercel did not materialize the selected GitHub source",
    );
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("includes provider stderr and a recovery action when source discovery fails", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "not a git repository", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 128, stderr: "permission denied", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 128, stderr: "directory missing", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      /Check the selected repository access.*permission denied.*directory missing/u,
    );
  });

  it("names a sandbox failure and redacts credentials while inspecting the checkout", async () => {
    const longDetail = `${"source inspection detail ".repeat(40)} token=github_pat_12345678901234567890 timeout`;
    const run = vi.fn().mockRejectedValue(new Error(longDetail));
    const operation = readSandboxGitHubSourceSnapshot({ run } as never, expected);
    await expect(operation).rejects.toThrow("could not inspect the Builder checkout");
    await expect(operation).rejects.toThrow("token=[REDACTED]");
    await expect(operation).rejects.toThrow("source inspection detail ".repeat(40));
  });

  it("reports manifest command stderr, its exit code, and a recovery action", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 127,
      stderr: "node: command not found",
      stdout: "",
    });
    await expect(
      writeSandboxGitHubSourceManifest({ run } as never, {
        sourceSha: sha,
        sourceTree: tree,
      }),
    ).rejects.toThrow(/manifest \(exit 127\).*Check that Git and Node.*node: command not found/u);
  });

  it("records a deleted tracked path as a working-tree deletion without restoring it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-source-manifest-deletion-"));
    const taskPath = "apps/spend-review/.config/mise/tasks/test-local-acceptance";
    const taskFile = path.join(root, taskPath);
    const sourceFile = path.join(root, "README.md");
    const appBuilder = path.join(root, ".app-builder");
    try {
      mkdirSync(path.dirname(taskFile), { recursive: true });
      writeFileSync(taskFile, "current source task\n");
      writeFileSync(sourceFile, "original source\n");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
      execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "source fixture"],
        { cwd: root },
      );
      const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf-8",
      }).trim();
      const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: root,
        encoding: "utf-8",
      }).trim();

      rmSync(taskFile);
      writeFileSync(sourceFile, "live edited source\n");
      const output = execFileSync(
        process.execPath,
        ["-e", sandboxGitHubSourceManifestProgram(root, appBuilder)],
        { encoding: "utf-8" },
      );
      const result = JSON.parse(output) as {
        sourceSha: string;
        sourceTree: string;
        workspaceDigest: string;
      };
      const files = JSON.parse(
        readFileSync(path.join(appBuilder, "source-files.json"), "utf-8"),
      ) as { path: string; sha256: string }[];
      const liveReadme = files.find(({ path: filePath }) => filePath === "README.md");
      expect(result).toMatchObject({ sourceSha, sourceTree });
      expect(files.map(({ path: filePath }) => filePath)).not.toContain(taskPath);
      expect(liveReadme?.sha256).toBe(
        createHash("sha256").update("live edited source\n").digest("hex"),
      );
      expect(result.workspaceDigest).toBe(
        createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      );
      expect(readFileSync(sourceFile, "utf-8")).toBe("live edited source\n");
      expect(() => readFileSync(taskFile, "utf-8")).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a mismatched provider checkout before linking it", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\nhttps://github.com/acme/other.git\n`,
      });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "does not match the selected GitHub source",
    );
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("rejects an occupied checkout from a different repository", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\nhttps://github.com/acme/other.git\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "does not match the selected GitHub source",
    );
  });

  it("rejects a checkout at a different revision", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${"c".repeat(40)}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "does not match the selected GitHub source",
    );
  });

  it("uses an occupied checkout at a newer revision of the selected repository", async () => {
    const newerSha = "c".repeat(40);
    const newerTree = "d".repeat(40);
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${newerSha}\n${newerTree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(
      readSandboxGitHubSourceSnapshot({ run } as never, { repository: expected.repository }),
    ).resolves.toMatchObject({ sourceSha: newerSha, sourceTree: newerTree });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not change a linked checkout left by an older Builder session", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "Start a new Builder session",
    );
    expect(run).toHaveBeenCalledTimes(2);
  });
});
