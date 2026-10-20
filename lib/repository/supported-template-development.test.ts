import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxSession } from "eve/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectPreparedSandboxWorkspace,
  inspectPreparedSandboxReleasePolicy,
  inspectSupportedRepository,
  prepareSupportedSandboxWorkspace,
  prepareDevelopmentSandboxWorkspace,
} from "./supported-template";
import type { PreparedSandboxWorkspace } from "./supported-template";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const record = (): PreparedSandboxWorkspace => ({
  adapter: "arrusted-development-v0",
  eligibilityDigest: "e".repeat(64),
  sourcePath: "/source",
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
  workspaceDigest: "d".repeat(64),
  workspaceId: "sandbox",
  workspacePath: "/workspace/repository",
});

describe("development Sandbox workspace verification", () => {
  it("accepts the inspection program's output key order", async () => {
    const workspace = record();
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify(
        Object.fromEntries([
          ["repositoryInput", "/workspace/repository"],
          ["realRepository", "/workspace/repository"],
          ["realWorkspace", "/workspace"],
          ["workspaceRoot", "/workspace"],
        ]),
      ),
    });

    await expect(
      inspectPreparedSandboxWorkspace(
        {
          id: "sandbox",
          readTextFile: vi.fn().mockResolvedValue(JSON.stringify(workspace)),
          run,
        } as never,
        "development-live",
      ),
    ).resolves.toEqual({ state: "prepared", workspace });
  });

  it("rejects real paths outside the Sandbox boundary", async () => {
    const workspace = record();
    await expect(
      inspectPreparedSandboxWorkspace(
        {
          id: "sandbox",
          readTextFile: vi.fn().mockResolvedValue(JSON.stringify(workspace)),
          run: vi.fn().mockResolvedValue({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              realRepository: "/tmp/repository",
              realWorkspace: "/workspace",
              repositoryInput: "/workspace/repository",
              workspaceRoot: "/workspace",
            }),
          }),
        } as never,
        "development-live",
      ),
    ).rejects.toThrow("escaped its sandbox boundary");
  });

  it("reports an inspection command failure distinctly", async () => {
    const workspace = record();
    await expect(
      inspectPreparedSandboxWorkspace(
        {
          id: "sandbox",
          readTextFile: vi.fn().mockResolvedValue(JSON.stringify(workspace)),
          run: vi.fn().mockResolvedValue({ exitCode: 1, stderr: "node failed", stdout: "" }),
        } as never,
        "development-live",
      ),
    ).rejects.toThrow("inspection command failed");
  });
});

describe("development Sandbox workspace refresh", () => {
  it("keeps generated files while source edits and deletions propagate", async () => {
    const source = mkdtempSync(path.join(tmpdir(), "app-builder-live-source-"));
    roots.push(source);
    writeFileSync(path.join(source, "changed.txt"), "before");
    writeFileSync(path.join(source, "deleted.txt"), "delete me");
    execFileSync("git", ["init", "--quiet"], { cwd: source });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: source });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: source });
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: source });

    const files = new Map<string, string | Buffer>();
    const removePath = vi.fn(({ path: target, recursive = false }) => {
      if (recursive) {
        for (const key of files.keys()) {
          if (key === target || key.startsWith(`${target}/`)) {
            files.delete(key);
          }
        }
      } else {
        files.delete(target);
      }
      return Promise.resolve();
    });
    const sandbox = {
      id: "sandbox",
      readTextFile: vi.fn(({ path: target }) => {
        const value = files.get(target);
        if (value === undefined) {
          return Promise.resolve(null);
        }
        return Promise.resolve(Buffer.isBuffer(value) ? value.toString("utf-8") : value);
      }),
      removePath,
      run: vi.fn(({ command }) => {
        if (command.includes("tar --extract")) {
          for (const name of ["changed.txt", "deleted.txt"]) {
            try {
              files.set(`repository/${name}`, readFileSync(path.join(source, name)));
            } catch {
              // The deleted source path is intentionally absent on refresh.
            }
          }
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      }),
      writeBinaryFile: vi.fn(({ content, path: target }) => {
        files.set(target, content);
        return Promise.resolve();
      }),
      writeFile: vi.fn<SandboxSession["writeFile"]>(async ({ content, path: target }) => {
        const reader = content.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Consume the file stream sequentially.
          const item = await reader.read();
          if (item.done) {
            break;
          }
          chunks.push(item.value);
        }
        files.set(target, Buffer.concat(chunks));
      }),
      writeTextFile: vi.fn(({ content, path: target }) => {
        files.set(target, content);
        return Promise.resolve();
      }),
    };

    await prepareDevelopmentSandboxWorkspace(source, sandbox as never, "first");
    files.set("repository/apps/generated/page.tsx", "generated");
    const largeSourceFile = Buffer.alloc(2 * 1024 * 1024, 0x61);
    writeFileSync(path.join(source, "changed.txt"), largeSourceFile);
    rmSync(path.join(source, "deleted.txt"));

    await prepareDevelopmentSandboxWorkspace(source, sandbox as never, "second");

    expect(files.get("repository/changed.txt")).toEqual(largeSourceFile);
    expect(files.has("repository/deleted.txt")).toBe(false);
    expect(files.get("repository/apps/generated/page.tsx")).toBe("generated");
    expect(removePath).not.toHaveBeenCalledWith(expect.objectContaining({ path: "repository" }));

    files.set(".app-builder/source-files.json", "not json");
    writeFileSync(path.join(source, "changed.txt"), "after corrupt receipt");
    await prepareDevelopmentSandboxWorkspace(source, sandbox as never, "third");

    expect(files.get("repository/changed.txt")?.toString()).toBe("after corrupt receipt");
    expect(files.get("repository/apps/generated/page.tsx")).toBe("generated");
    expect(removePath).not.toHaveBeenCalledWith(expect.objectContaining({ path: "repository" }));
  });
});

const legacyWorkspaceFixture = () => {
  const source = mkdtempSync(path.join(tmpdir(), "app-builder-legacy-source-"));
  roots.push(source);
  mkdirSync(path.join(source, ".config/mise"), { recursive: true });
  mkdirSync(path.join(source, "scripts"));
  writeFileSync(
    path.join(source, ".config/mise/config.toml"),
    '[tasks]\n"app:check" = { run = "node scripts/check.cjs" }\n',
  );
  writeFileSync(path.join(source, "scripts/check.cjs"), 'process.stdout.write("checked");');
  writeFileSync(path.join(source, "app.txt"), "original");
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: source });
  execFileSync("git", ["-c", "commit.gpgsign=false", "add", "."], { cwd: source });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], {
    cwd: source,
  });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf-8" }).trim();
  const files = new Map<string, Buffer>();
  const sandbox = {
    id: "sandbox",
    readTextFile: vi.fn(({ path: target }: { path: string }) =>
      Promise.resolve(files.get(target)?.toString("utf-8") ?? null),
    ),
    readBinaryFile: vi.fn(({ path: target }: { path: string }) =>
      Promise.resolve(files.get(target) ?? null),
    ),
    removePath: vi.fn(({ path: target, recursive }: { path: string; recursive?: boolean }) => {
      for (const name of files.keys()) {
        if (name === target || (recursive === true && name.startsWith(`${target}/`))) {
          files.delete(name);
        }
      }
      return Promise.resolve();
    }),
    run: vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          repositoryInput: "/workspace/repository",
          realRepository: "/workspace/repository",
          realWorkspace: "/workspace",
          workspaceRoot: "/workspace",
        }),
      }),
    ),
    writeFile: vi.fn<SandboxSession["writeFile"]>(async ({ content, path: target }) => {
      const reader = content.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Consume each source stream sequentially.
        const item = await reader.read();
        if (item.done) {
          break;
        }
        chunks.push(item.value);
      }
      files.set(target, Buffer.concat(chunks));
    }),
    writeTextFile: vi.fn(({ content, path: target }: { content: string; path: string }) => {
      files.set(target, Buffer.from(content));
      return Promise.resolve();
    }),
  };
  return { files, sandbox, sha, source };
};

describe("legacy writable Sandbox workspace", () => {
  it("transfers working commands despite advisory layout failures and preserves later edits on reuse", async () => {
    const { files, sandbox, sha, source } = legacyWorkspaceFixture();
    const inspection = await inspectSupportedRepository(source);
    expect(inspection.eligible).toBe(false);
    const prepared = await prepareSupportedSandboxWorkspace(
      source,
      sha,
      "e".repeat(64),
      sandbox as never,
      "first",
    );
    expect(
      execFileSync(
        process.execPath,
        ["-e", files.get("repository/scripts/check.cjs")?.toString() ?? "throw 0"],
        { encoding: "utf-8" },
      ),
    ).toBe("checked");
    files.set("repository/app.txt", Buffer.from("repaired"));
    files.set("repository/new.txt", Buffer.from("new app file"));
    files.delete("repository/scripts/check.cjs");
    sandbox.removePath.mockClear();
    sandbox.writeFile.mockClear();
    await expect(
      prepareSupportedSandboxWorkspace(
        source,
        sha,
        "f".repeat(64),
        sandbox as never,
        "again",
        false,
        "planning",
      ),
    ).resolves.toEqual(prepared);
    await expect(inspectPreparedSandboxWorkspace(sandbox as never, "legacy-live")).resolves.toEqual(
      { state: "prepared", workspace: prepared },
    );
    expect(files.get("repository/app.txt")?.toString()).toBe("repaired");
    expect(files.get("repository/new.txt")?.toString()).toBe("new app file");
    expect(files.has("repository/scripts/check.cjs")).toBe(false);
    expect(sandbox.removePath).not.toHaveBeenCalled();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    await expect(inspectPreparedSandboxWorkspace(sandbox as never)).rejects.toThrow(
      "drifted or is missing",
    );
  });

  it("does not seal a failed initial transfer", async () => {
    const { files, sandbox, sha, source } = legacyWorkspaceFixture();
    sandbox.readBinaryFile.mockImplementation(({ path: target }) =>
      Promise.resolve(
        target === "repository/app.txt"
          ? Buffer.from("corrupt transfer")
          : (files.get(target) ?? null),
      ),
    );
    await expect(
      prepareSupportedSandboxWorkspace(source, sha, "e".repeat(64), sandbox as never, "first"),
    ).rejects.toThrow("drifted or is missing");
    expect(
      sandbox.writeTextFile.mock.calls.some(([input]) =>
        input.path.endsWith("prepared-workspace.json"),
      ),
    ).toBe(false);
  });

  it("rejects a different Sandbox or selected source before replacing content", async () => {
    const { files, sandbox, sha, source } = legacyWorkspaceFixture();
    await prepareSupportedSandboxWorkspace(source, sha, "e".repeat(64), sandbox as never, "first");
    files.set("repository/app.txt", Buffer.from("keep repair"));
    sandbox.removePath.mockClear();
    await expect(
      prepareSupportedSandboxWorkspace(
        source,
        sha,
        "e".repeat(64),
        { ...sandbox, id: "other" } as never,
        "again",
      ),
    ).rejects.toThrow("different workspace");
    await expect(
      prepareSupportedSandboxWorkspace(
        source,
        "a".repeat(40),
        "e".repeat(64),
        sandbox as never,
        "again",
      ),
    ).rejects.toThrow("Source SHA changed");
    expect(files.get("repository/app.txt")?.toString()).toBe("keep repair");
    expect(sandbox.removePath).not.toHaveBeenCalled();
  });

  it("rejects a realpath escape and damaged baseline provenance on live reads", async () => {
    const { files, sandbox, sha, source } = legacyWorkspaceFixture();
    await prepareSupportedSandboxWorkspace(source, sha, "e".repeat(64), sandbox as never, "first");
    sandbox.run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        repositoryInput: "/workspace/repository",
        realRepository: "/other",
        realWorkspace: "/workspace",
        workspaceRoot: "/workspace",
      }),
    });
    await expect(inspectPreparedSandboxWorkspace(sandbox as never, "legacy-live")).rejects.toThrow(
      "escaped its sandbox boundary",
    );
    files.set(".app-builder/source-files.json", Buffer.from("[]"));
    await expect(inspectPreparedSandboxWorkspace(sandbox as never, "legacy-live")).rejects.toThrow(
      "manifest is invalid",
    );
  });

  it("checks release workflow bytes without freezing mutable app content", async () => {
    const fixture = legacyWorkspaceFixture();
    mkdirSync(path.join(fixture.source, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(fixture.source, ".github/workflows/cd.yml"), "jobs: {}\n");
    execFileSync("git", ["add", "."], { cwd: fixture.source });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "release policy"],
      { cwd: fixture.source },
    );
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.source,
      encoding: "utf-8",
    }).trim();
    const prepared = await prepareSupportedSandboxWorkspace(
      fixture.source,
      sha,
      "e".repeat(64),
      fixture.sandbox as never,
      "first",
    );
    fixture.files.set("repository/app.txt", Buffer.from("ordinary edit"));
    const input = {
      sandbox: fixture.sandbox as never,
      sourceSha: prepared.sourceSha,
      sourceTree: prepared.sourceTree,
      workspaceDigest: prepared.workspaceDigest,
    };
    await expect(inspectPreparedSandboxReleasePolicy(input)).resolves.toMatchObject({
      eligible: false,
      workflow: { status: "present" },
    });
    fixture.files.set("repository/.github/workflows/cd.yml", Buffer.from("jobs: {unsafe: {}}\n"));
    await expect(inspectPreparedSandboxReleasePolicy(input)).rejects.toThrow(
      "release-policy bytes changed after review",
    );
  });
});
