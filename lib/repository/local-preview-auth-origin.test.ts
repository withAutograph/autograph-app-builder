import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { SandboxSession } from "eve/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
  localPreviewAuthOriginReadProgram,
  readLocalPreviewAuthOrigin,
} from "./local-preview-auth-origin";

const runLocalPreviewAuthOriginRead = (target: string, optionalBrowserOrigin = false) =>
  spawnSync(
    process.execPath,
    ["-e", localPreviewAuthOriginReadProgram(target, optionalBrowserOrigin)],
    {
      encoding: "utf-8",
    },
  );

describe("owned previous local preview Auth origin", () => {
  it("reads only the actual private origin and refuses permissive files or symlinks", () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "builder-auth-origin-")));
    chmodSync(directory, 0o700);
    const file = path.join(directory, "environment.json");
    const contents = {
      APP_DATABASE_URL: "postgres://private",
      BETTER_AUTH_SECRET: "private-never-returned",
      BETTER_AUTH_URL: "https://old-owned-preview.vercel.run",
    };
    writeFileSync(file, JSON.stringify(contents), { mode: 0o600 });
    try {
      const read = runLocalPreviewAuthOriginRead(file);
      expect(read.status).toBe(0);
      expect(JSON.parse(read.stdout)).toBe(contents.BETTER_AUTH_URL);
      expect(read.stdout).not.toContain("private");
      expect(
        JSON.parse(runLocalPreviewAuthOriginRead(path.join(directory, "absent.json"), true).stdout),
      ).toBeNull();
      expect(runLocalPreviewAuthOriginRead(file, true).status).not.toBe(0);
      const matching = { ...contents, APP_TEST_BASE_URL: contents.BETTER_AUTH_URL };
      writeFileSync(file, JSON.stringify(matching));
      expect(JSON.parse(runLocalPreviewAuthOriginRead(file, true).stdout)).toBe(
        contents.BETTER_AUTH_URL,
      );
      writeFileSync(file, JSON.stringify(contents));
      chmodSync(file, 0o644);
      expect(runLocalPreviewAuthOriginRead(file).status).not.toBe(0);
      chmodSync(file, 0o600);
      const link = path.join(directory, "link.json");
      symlinkSync(file, link);
      expect(runLocalPreviewAuthOriginRead(link).status).not.toBe(0);
      expect(readFileSync(file, "utf-8")).toBe(JSON.stringify(contents));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
  it("binds a bounded provider read to the server-derived state path and cancellation", async () => {
    const run = vi.fn<SandboxSession["run"]>(async () => {
      await Promise.resolve();
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify("https://old-owned-preview.vercel.run"),
      };
    });
    const controller = new AbortController();
    await expect(
      readLocalPreviewAuthOrigin({
        appId: "supplier-spend",
        root: "/workspace/repository",
        sandbox: { run },
        signal: controller.signal,
      }),
    ).resolves.toBe("https://old-owned-preview.vercel.run");
    expect(run.mock.calls[0]?.[0].command).toContain("/tmp/autograph-app-runtime/");
    expect(run.mock.calls[0]?.[0].abortSignal).toBe(controller.signal);
    run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify("https://customer.example"),
    });
    await expect(
      readLocalPreviewAuthOrigin({
        appId: "supplier-spend",
        root: "/workspace/repository",
        sandbox: { run },
      }),
    ).rejects.toThrow();
    controller.abort();
    await expect(
      readLocalPreviewAuthOrigin({
        appId: "supplier-spend",
        root: "/workspace/repository",
        sandbox: { run },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
