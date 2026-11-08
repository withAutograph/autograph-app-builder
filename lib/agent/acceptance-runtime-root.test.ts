/* oxlint-disable eslint/require-await, eslint/no-nested-ternary, sonarjs/no-nested-conditional, unicorn/no-await-expression-member, github/no-then, typescript/strict-void-return, unicorn/no-useless-undefined -- Controlled recovery fixtures model release observations and clean up only their temporary Git repositories. */
import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareWithVerifiedGitHubFetchRecovery } from "./verified-github-fetch-recovery";
import {
  attachAvailableAcceptanceDependencies,
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
    const recover = vi.fn<() => Promise<string>>().mockResolvedValue("/separate-recovered");
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
  it("reports an actual dependency failure from the recovered command instead of a release mismatch", async () => {
    await expect(
      resolveCompatibleAcceptanceRoot({
        roots: ["/expired"],
        releaseId: "v3",
        describe: async (root) => {
          throw new Error(
            root === "/expired"
              ? "workspace absent"
              : "app:describe: Cannot find package @platform/schema",
          );
        },
        recover: async () => "/recovered",
      }),
    ).rejects.toThrow("app:describe: Cannot find package @platform/schema");
  });
  it("does not recover a workspace after cancellation while probing a retained root", async () => {
    const controller = new AbortController();
    const recover = vi.fn();
    await expect(
      resolveCompatibleAcceptanceRoot({
        roots: ["/retained"],
        releaseId: "v3",
        signal: controller.signal,
        describe: async () => {
          controller.abort(new Error("cancelled"));
          throw new Error("aborted command");
        },
        recover,
      }),
    ).rejects.toThrow("cancelled");
    expect(recover).not.toHaveBeenCalled();
  });
  it("refreshes verified repository credentials once after a rejected fetch and preserves the partial checkout", async () => {
    const roots: string[] = [];
    const commands: string[] = [];
    const acquireCredential = vi.fn(async () => ({ token: "private-installation-token" }));
    const setNetworkPolicy = vi.fn<() => Promise<void>>().mockResolvedValue();
    const result = await prepareWithVerifiedGitHubFetchRecovery({
      acquireCredential,
      sandbox: { setNetworkPolicy },
      prepare: async () => {
        const root = `/workspace/recovered-${roots.length}`;
        roots.push(root);
        return await recoverAcceptanceCheckout({
          sandbox: {
            run: async ({ command }) => {
              commands.push(command);
              return roots.length === 1 && command.includes(" fetch ")
                ? {
                    exitCode: 128,
                    stderr: "remote: Repository not found.\nprivate provider detail",
                    stdout: "",
                  }
                : { exitCode: 0, stderr: "", stdout: "" };
            },
          },
          repositoryUrl: "https://github.com/owner/existing.git",
          revision: "published",
          root,
          workingDirectory: "/workspace",
          signal: new AbortController().signal,
        });
      },
    });
    expect(result).toEqual({ prepared: "/workspace/recovered-1", retriedGitFetch: true });
    expect(acquireCredential).toHaveBeenCalledTimes(2);
    expect(roots).toEqual(["/workspace/recovered-0", "/workspace/recovered-1"]);
    expect(commands).toHaveLength(5);
    expect(commands.some((command) => command.includes("rm "))).toBe(false);
    expect(setNetworkPolicy).toHaveBeenLastCalledWith("allow-all");
  });
  it("does not refresh credentials for an unrelated Git failure or disclose transport output", async () => {
    const acquireCredential = vi.fn(async () => ({ token: "private-token" }));
    await expect(
      prepareWithVerifiedGitHubFetchRecovery({
        acquireCredential,
        sandbox: { setNetworkPolicy: async () => {} },
        prepare: async () =>
          await recoverAcceptanceCheckout({
            sandbox: {
              run: async () => ({
                exitCode: 128,
                stderr: "fatal: unknown revision; private transport detail",
                stdout: "",
              }),
            },
            repositoryUrl: "https://github.com/owner/existing.git",
            revision: "missing",
            root: "/workspace/new",
            workingDirectory: "/workspace",
            signal: new AbortController().signal,
          }),
      }),
    ).rejects.toThrow("could not recover the published acceptance source (exit 128)");
    expect(acquireCredential).toHaveBeenCalledOnce();
  });
  it("uses real filesystem attachment when history is missing, then reuses an available retained dependency source", async () => {
    const run = promisify(execFile);
    const workspace = await mkdtemp(path.join(tmpdir(), "builder-acceptance-dependencies-"));
    const recoveredRoot = path.join(workspace, "recovered");
    const retainedRoot = path.join(workspace, "retained");
    const missingRoot = path.join(workspace, "missing-history");
    const sandbox = {
      run: async ({
        command,
        workingDirectory,
      }: {
        command: string;
        workingDirectory?: string;
      }) => {
        try {
          return {
            ...(await run(
              "/bin/sh",
              [
                "-c",
                command.replace(/^node /u, `'${process.execPath.replaceAll("'", "'\"'\"'")}' `),
              ],
              { cwd: workingDirectory },
            )),
            exitCode: 0,
          };
        } catch {
          return { exitCode: 1, stderr: "command failed", stdout: "" };
        }
      },
    };
    const { signal } = new AbortController();
    try {
      await mkdir(recoveredRoot);
      await writeFile(path.join(recoveredRoot, "release"), "v3");
      await expect(
        attachAvailableAcceptanceDependencies({
          sandbox,
          roots: [missingRoot],
          recoveredRoot,
          workspaceRoot: workspace,
          signal,
        }),
      ).resolves.toBeUndefined();
      expect(await readFile(path.join(recoveredRoot, "release"), "utf-8")).toBe("v3");
      // No installation is invented when all retained sources are gone. Actual repository execution
      // can still run without dependencies or report its precise missing-package failure.
      const packageRoot = path.join(retainedRoot, "node_modules", "fixture-package");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(path.join(packageRoot, "index.js"), "export const retained = true;");
      await attachAvailableAcceptanceDependencies({
        sandbox,
        roots: [missingRoot, retainedRoot],
        recoveredRoot,
        workspaceRoot: workspace,
        signal,
      });
      expect(
        await readFile(path.join(recoveredRoot, "node_modules/fixture-package/index.js"), "utf-8"),
      ).toBe("export const retained = true;");
      expect(await readFile(path.join(packageRoot, "index.js"), "utf-8")).toBe(
        "export const retained = true;",
      );
      expect(await readFile(path.join(recoveredRoot, "release"), "utf-8")).toBe("v3");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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
                  return { exitCode: 1, stderr: "Git command failed", stdout: "" };
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
