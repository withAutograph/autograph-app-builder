/* oxlint-disable eslint/require-await, eslint/no-nested-ternary, sonarjs/no-nested-conditional, unicorn/no-await-expression-member, github/no-then, typescript/strict-void-return, unicorn/no-useless-undefined -- Controlled recovery fixtures model release observations and clean up only their temporary Git repositories. */
import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  recoverAcceptanceCheckout,
  resolveCompatibleAcceptanceRoot,
} from "./acceptance-runtime-root";

describe("acceptance workspace recovery", () => {
  it("runs ordinary source edits when the app still describes the installed release", async () => {
    const recover = vi.fn();
    await expect(
      resolveCompatibleAcceptanceRoot({
        roots: ["/candidate-with-edits", "/old"],
        releaseId: "v3",
        describe: async (root) => (root.includes("candidate") ? "v3" : "v1"),
        recover,
      }),
    ).resolves.toBe("/candidate-with-edits");
    expect(recover).not.toHaveBeenCalled();
  });
  it("recovers a missing retained workspace and a stale applied workspace without overwriting either", async () => {
    const describeRelease = vi.fn(async (root: string) =>
      root === "/missing" ? undefined : root === "/old" ? "v1" : "v3",
    );
    const recover = vi.fn(async () => "/separate-recovered");
    await expect(
      resolveCompatibleAcceptanceRoot({
        roots: ["/missing", "/old"],
        releaseId: "v3",
        describe: describeRelease,
        recover,
      }),
    ).resolves.toBe("/separate-recovered");
    expect(recover).toHaveBeenCalledOnce();
    expect(describeRelease.mock.calls.map(([root]) => root)).toEqual([
      "/missing",
      "/old",
      "/separate-recovered",
    ]);
  });
  it("keeps an actual recovery failure visible", async () => {
    await expect(
      resolveCompatibleAcceptanceRoot({
        roots: ["/old"],
        releaseId: "v3",
        describe: async () => "v1",
        recover: async () => {
          throw new Error("repository access expired");
        },
      }),
    ).rejects.toThrow("repository access expired");
  });
  it("does not restore credentials into a recovered checkout that cannot describe the installed release", async () => {
    await expect(
      resolveCompatibleAcceptanceRoot({
        roots: [],
        releaseId: "v3",
        describe: async () => "v2",
        recover: async () => "/recovered",
      }),
    ).rejects.toThrow("installed release");
  });
  it("reconstructs a missing published checkout with real Git while preserving private edits", async () => {
    const run = promisify(execFile);
    const directory = await mkdtemp(path.join(tmpdir(), "builder-acceptance-recovery-"));
    const source = path.join(directory, "source");
    const old = path.join(directory, "old");
    const recovered = path.join(directory, "recovered");
    const git = async (...args: string[]) => await run("git", ["-C", source, ...args]);
    try {
      await mkdir(source);
      await mkdir(old);
      await writeFile(path.join(old, "release"), "v1");
      await writeFile(path.join(old, "private-edit"), "preserve");
      await git("init");
      await git("config", "user.name", "Builder fixture");
      await git("config", "user.email", "fixture@example.invalid");
      await writeFile(path.join(source, "release"), "v3");
      await git("add", "release");
      await git("-c", "commit.gpgsign=false", "commit", "-m", "published v3");
      const revision = (await git("rev-parse", "HEAD")).stdout.trim();
      await writeFile(path.join(source, "release"), "v4");
      await git("add", "release");
      await git("-c", "commit.gpgsign=false", "commit", "-m", "later work");
      const root = await resolveCompatibleAcceptanceRoot({
        roots: [path.join(directory, "expired"), old],
        releaseId: "v3",
        describe: async (candidateRoot) =>
          await readFile(path.join(candidateRoot, "release"), "utf-8").catch(() => undefined),
        recover: async () =>
          await recoverAcceptanceCheckout({
            sandbox: {
              run: async ({ command, workingDirectory }) => {
                try {
                  const result = await run("/bin/sh", ["-c", command], { cwd: workingDirectory });
                  return { ...result, exitCode: 0 };
                } catch {
                  return { stdout: "", stderr: "Git command failed", exitCode: 1 };
                }
              },
            },
            repositoryUrl: source,
            revision,
            root: recovered,
            workingDirectory: directory,
            signal: new AbortController().signal,
          }),
      });
      expect(root).toBe(recovered);
      expect(await readFile(path.join(recovered, "release"), "utf-8")).toBe("v3");
      expect(await readFile(path.join(old, "release"), "utf-8")).toBe("v1");
      expect(await readFile(path.join(old, "private-edit"), "utf-8")).toBe("preserve");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
