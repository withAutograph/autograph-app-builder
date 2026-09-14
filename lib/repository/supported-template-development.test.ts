import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectPreparedSandboxWorkspace,
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
      writeTextFile: vi.fn(({ content, path: target }) => {
        files.set(target, content);
        return Promise.resolve();
      }),
    };

    await prepareDevelopmentSandboxWorkspace(source, sandbox as never, "first");
    files.set("repository/apps/generated/page.tsx", "generated");
    writeFileSync(path.join(source, "changed.txt"), "after");
    rmSync(path.join(source, "deleted.txt"));

    await prepareDevelopmentSandboxWorkspace(source, sandbox as never, "second");

    expect(files.get("repository/changed.txt")?.toString()).toBe("after");
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
