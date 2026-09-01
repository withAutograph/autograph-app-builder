import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import { inspectDependencyCache } from "./dependency-cache";
import {
  ExistingAppChangePreimageError,
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  materializePlanningOverlay,
  sandboxTargetCommandExecutor,
  TARGET_PLANNING_MISE_PROFILE,
  TRACKED_SOURCE_ARCHIVE_COMMAND,
  targetContractDigest,
  targetExecutionBinding,
  targetProposalSchema,
  type TargetCommandExecutor,
} from "./target-planning";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runLocal(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown error"}`,
    );
}

function sandboxFixture() {
  const files = new Map<string, string | Uint8Array>([
    [
      ".app-builder/source-files.json",
      JSON.stringify([
        { path: "microfrontends.json", mode: "100644" },
        { path: "apps/shell/app/auth/[[...path]]/page.tsx", mode: "100644" },
        { path: "apps/vendor/app/page.tsx", mode: "100644" },
        { path: "docs/assets/Autograph FavIcon.png", mode: "100644" },
      ]),
    ],
    ["repository/microfrontends.json", "{}\n"],
    ["repository/apps/shell/app/auth/[[...path]]/page.tsx", "export {};\n"],
    [
      "repository/apps/vendor/app/page.tsx",
      "export default function Page() {}\n",
    ],
    ["repository/docs/assets/Autograph FavIcon.png", "fixture\n"],
  ]);
  const run = vi.fn(async (input: unknown) => {
    void input;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const sandbox = {
    id: "fixture-sandbox",
    resolvePath: (path: string) => `/workspace/${path}`,
    readTextFile: async ({ path }: { path: string }) => {
      const value = files.get(path);
      return typeof value === "string" ? value : null;
    },
    readBinaryFile: async ({ path }: { path: string }) => {
      const value = files.get(path);
      return value === undefined
        ? null
        : typeof value === "string"
          ? new TextEncoder().encode(value)
          : value;
    },
    writeTextFile: async ({
      path,
      content,
    }: {
      path: string;
      content: string;
    }) => {
      files.set(path, content);
    },
    writeBinaryFile: async ({
      path,
      content,
    }: {
      path: string;
      content: Uint8Array;
    }) => {
      files.set(path, content);
    },
    run,
  } as unknown as SandboxSession;
  return { files, run, sandbox };
}

describe("typed target identity and planning", () => {
  it("materializes only builder-owned inputs and parses target-produced receipts", async () => {
    const { files, sandbox } = sandboxFixture();
    const calls: string[] = [];
    const fixture = fixtureTargetCommandExecutor();
    const executor: TargetCommandExecutor = async (input) => {
      calls.push(input.command);
      return fixture(input);
    };
    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor,
      appId: "expense-review",
      appSpecContent: "accepted",
      appSpecDigest: "a".repeat(64),
      artifactRevision: "b".repeat(64),
    });
    expect(calls).toEqual(["identity", "planning"]);
    expect(result.identity.packageName).toBe("@autograph/expense-review");
    expect(result.proposal.contract.appSpec.sha256).toBe("a".repeat(64));
    expect(result.contractDigest).toBe(
      targetContractDigest(result.proposal.contract),
    );
    expect(
      files.has(
        `.app-builder/target-inputs/${"b".repeat(64)}/app-contract.json`,
      ),
    ).toBe(true);
    expect(
      files.get(
        `.app-builder/target-inputs/${"b".repeat(64)}/repository/.config/mise/config.app-builder.toml`,
      ),
    ).toBe(TARGET_PLANNING_MISE_PROFILE);
    expect(files.has("repository/prototype/expense-review/app-spec.md")).toBe(
      false,
    );
  });

  it("rejects malformed target output and unavailable real prerequisites", async () => {
    const { sandbox } = sandboxFixture();
    await expect(
      executeTargetIdentityAndPlanning({
        sandbox,
        executor: async () => ({
          exitCode: 0,
          stdout: '{"appId":"expense-review","extra":true}',
          stderr: "",
        }),
        appId: "expense-review",
        appSpecContent: "accepted",
        appSpecDigest: "a".repeat(64),
        artifactRevision: "b".repeat(64),
      }),
    ).rejects.toThrow("invalid shape");
    const cache = await inspectDependencyCache(sandbox, process.env);
    expect(() => targetExecutionBinding(cache, {})).toThrow(
      "offline dependency cache",
    );
  });

  it("binds only the exact closed Vercel Development execution identity", async () => {
    const { sandbox } = sandboxFixture();
    const cache = await inspectDependencyCache(sandbox, process.env);
    const environment = {
      APP_BUILDER_EXECUTION_MODE: "development",
      APP_BUILDER_SANDBOX_PROVIDER: "vercel",
      APP_BUILDER_EXECUTION_BUNDLE: "local-development",
      APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: "2".repeat(64),
      APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY: "3".repeat(64),
    };

    expect(targetExecutionBinding(cache, environment)).toEqual({
      imageDigest:
        "vercel-sandbox-development@sha256:b67c32f494ac7dd5431a255f57dc6cbf04a12033cf65c25d6e2e8076b51b80c6",
      dependencyCacheDigest: `sha256:${cache.manifestDigest}`,
      fixture: false,
    });
    expect(() =>
      targetExecutionBinding(cache, {
        ...environment,
        APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: "not-a-digest",
      }),
    ).toThrow("Development execution identity was invalid.");
    expect(() =>
      targetExecutionBinding(cache, {
        APP_BUILDER_EXECUTION_MODE: "development",
        APP_BUILDER_SANDBOX_PROVIDER: "vercel",
      }),
    ).toThrow("offline dependency cache");
  });

  it("uses only fixed commands, cwd, and an abort signal", async () => {
    const { run, sandbox } = sandboxFixture();
    const executor = sandboxTargetCommandExecutor(sandbox);
    await executor({
      command: "identity",
      appId: "expense-review",
      planningRoot: "/workspace/.app-builder/target-inputs/revision/repository",
      contractPath:
        "/workspace/.app-builder/target-inputs/revision/contract.json",
      appSpecDigest: "a".repeat(64),
    });
    expect(run).toHaveBeenCalledWith({
      command:
        "MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false mise --env app-builder run --no-deps --skip-tools repository:exec -- app-identity.ts --app expense-review",
      workingDirectory:
        "/workspace/.app-builder/target-inputs/revision/repository",
      abortSignal: expect.any(AbortSignal),
    });
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("env");
  });

  it("binds existing-app postimages to exact source preimages", async () => {
    const { sandbox } = sandboxFixture();
    const fixture = fixtureTargetCommandExecutor();
    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor: fixture,
      appId: "vendor",
      appSpecContent: "accepted",
      appSpecDigest: "a".repeat(64),
      artifactRevision: "b".repeat(64),
      existingAppChanges: [
        {
          path: "apps/vendor/app/page.tsx",
          content: "export default function Page() { return 'Finance'; }\n",
        },
      ],
    });
    expect("operation" in result.proposal && result.proposal.operation).toBe(
      "iterate-existing-app",
    );
    if (!("operation" in result.proposal)) throw new Error("missing iteration");
    expect(result.proposal.iteration.changes[0]).toMatchObject({
      path: "apps/vendor/app/page.tsx",
      before: { mode: "644" },
      after: { mode: "644" },
    });
    expect(
      targetProposalSchema.safeParse({
        ...result.proposal,
        iteration: { ...result.proposal.iteration, digest: "0".repeat(64) },
      }).success,
    ).toBe(false);
  });

  it("returns exact app-owned preimages and retries without recording an invalid identity", async () => {
    const { sandbox } = sandboxFixture();
    const executor = vi.fn(fixtureTargetCommandExecutor());
    const onIdentity = vi.fn();
    const input = {
      sandbox,
      executor,
      appId: "vendor",
      appSpecContent: "accepted",
      appSpecDigest: "a".repeat(64),
      artifactRevision: "b".repeat(64),
      onIdentity,
    };

    const invalid = executeTargetIdentityAndPlanning({
      ...input,
      existingAppChanges: [
        {
          path: "apps/vendor/app/missing.tsx",
          content: "changed\n",
        },
      ],
    });
    await expect(invalid).rejects.toBeInstanceOf(
      ExistingAppChangePreimageError,
    );
    await expect(invalid).rejects.toMatchObject({
      code: "existing_app_change_preimage_missing",
      rejectedPaths: ["apps/vendor/app/missing.tsx"],
      exactAppOwnedPaths: ["apps/vendor/app/page.tsx"],
    });
    expect(onIdentity).not.toHaveBeenCalled();

    const planned = await executeTargetIdentityAndPlanning({
      ...input,
      existingAppChanges: [
        {
          path: "apps/vendor/app/page.tsx",
          content: "export default function Page() { return 'Ready'; }\n",
        },
      ],
    });
    const afterContent = "export default function Page() { return 'Ready'; }\n";
    const change = {
      path: "apps/vendor/app/page.tsx",
      before: {
        mode: "644",
        digest: digest("export default function Page() {}\n"),
      },
      after: {
        mode: "644",
        digest: digest(afterContent),
        content: afterContent,
      },
    };
    expect(planned.proposal).toMatchObject({
      operation: "iterate-existing-app",
      iteration: {
        changes: [change],
        digest: digest(JSON.stringify([change])),
      },
    });
    expect(onIdentity).toHaveBeenCalledTimes(1);
  });

  it("materializes real planning overlays from tracked Git bytes only", () => {
    expect(TRACKED_SOURCE_ARCHIVE_COMMAND).toBe(
      "git -C repository archive --format=tar HEAD",
    );
    expect(TRACKED_SOURCE_ARCHIVE_COMMAND).not.toContain("tar -C repository");
  });

  it("executes a real tracked-only planning overlay without dirty or untracked bytes", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "app-builder-planning-overlay-"),
    );
    const workspace = join(temporaryRoot, "workspace");
    const repository = join(workspace, "repository");
    const trackedPath = "apps/vendor/app/page.tsx";
    const untrackedPath = "apps/vendor/app/untracked.tsx";
    const absolutePath = (path: string) =>
      path === "/workspace"
        ? workspace
        : path.startsWith("/workspace/")
          ? join(workspace, path.slice("/workspace/".length))
          : join(workspace, path);
    const readBinary = async (path: string) => {
      try {
        return new Uint8Array(await readFile(absolutePath(path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    const sandbox = {
      id: "local-command-sandbox",
      resolvePath: (path: string) => `/workspace/${path}`,
      readTextFile: async ({ path }: { path: string }) => {
        try {
          return await readFile(absolutePath(path), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      readBinaryFile: async ({ path }: { path: string }) => readBinary(path),
      writeTextFile: async ({
        path,
        content,
      }: {
        path: string;
        content: string;
      }) => {
        const destination = absolutePath(path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, "utf8");
      },
      writeBinaryFile: async ({
        path,
        content,
      }: {
        path: string;
        content: Uint8Array;
      }) => {
        const destination = absolutePath(path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
      },
      run: async ({
        command,
        workingDirectory,
      }: {
        command: string;
        workingDirectory: string;
      }) => {
        const result = spawnSync("/bin/sh", ["-c", command], {
          cwd: absolutePath(workingDirectory),
          encoding: "utf8",
        });
        return {
          exitCode: result.status ?? 1,
          stdout: result.stdout,
          stderr: result.stderr || result.error?.message || "",
        };
      },
    } as unknown as SandboxSession;
    const committed =
      "export default function Page() { return 'Committed'; }\n";
    const dirty = "export default function Page() { return 'Dirty'; }\n";

    try {
      await mkdir(join(repository, dirname(trackedPath)), { recursive: true });
      await writeFile(join(repository, trackedPath), committed, "utf8");
      runLocal("git", ["init", "--quiet"], repository);
      runLocal("git", ["add", trackedPath], repository);
      runLocal(
        "git",
        [
          "-c",
          "user.name=Autograph Test",
          "-c",
          "user.email=autograph@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        repository,
      );
      await writeFile(join(repository, trackedPath), dirty, "utf8");
      await writeFile(join(repository, untrackedPath), "untracked\n", "utf8");
      await mkdir(join(workspace, ".app-builder"), { recursive: true });
      await writeFile(
        join(workspace, ".app-builder/source-files.json"),
        JSON.stringify([{ path: trackedPath, mode: "100644" }]),
        "utf8",
      );
      vi.stubEnv("APP_BUILDER_REAL_SANDBOX", "1");

      await materializePlanningOverlay({
        sandbox,
        artifactRevision: "b".repeat(64),
        appId: "vendor",
        appSpecContent: "accepted",
        appSpecDigest: "a".repeat(64),
      });

      const overlayRoot = join(
        workspace,
        ".app-builder/target-inputs",
        "b".repeat(64),
        "repository",
      );
      await expect(
        readFile(join(overlayRoot, trackedPath), "utf8"),
      ).resolves.toBe(committed);
      await expect(
        readFile(join(overlayRoot, untrackedPath), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("refuses to run the creation planner for an existing application", async () => {
    const { sandbox } = sandboxFixture();
    const executor = vi.fn(fixtureTargetCommandExecutor());
    await expect(
      executeTargetIdentityAndPlanning({
        sandbox,
        executor,
        appId: "vendor",
        appSpecContent: "accepted",
        appSpecDigest: "a".repeat(64),
        artifactRevision: "b".repeat(64),
      }),
    ).rejects.toThrow(
      "The requested application already exists. Inspect its app-owned source files",
    );
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ command: "identity" }),
    );
  });

  it("rejects path escapes, other-app paths, and missing preimages", async () => {
    const { sandbox } = sandboxFixture();
    const base = {
      sandbox,
      executor: fixtureTargetCommandExecutor(),
      appId: "vendor",
      appSpecContent: "accepted",
      appSpecDigest: "a".repeat(64),
      artifactRevision: "b".repeat(64),
    };
    for (const path of [
      "../secrets",
      "apps/shell/app/page.tsx",
      "apps/vendor/app/missing.tsx",
      "apps/vendor/app.contract.json",
    ])
      await expect(
        executeTargetIdentityAndPlanning({
          ...base,
          existingAppChanges: [{ path, content: "changed\n" }],
        }),
      ).rejects.toThrow();
  });
});
