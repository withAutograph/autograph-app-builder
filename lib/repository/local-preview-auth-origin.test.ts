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

describe("owned previous local preview Auth origin", () => {
  it("reads only the actual private origin and refuses permissive files or symlinks", () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "builder-auth-origin-")));
    chmodSync(directory, 0o700);
    const file = path.join(directory, "environment.json");
    const contents = {
      BETTER_AUTH_URL: "https://old-owned-preview.vercel.run",
      BETTER_AUTH_SECRET: "private-never-returned",
      APP_DATABASE_URL: "postgres://private",
    };
    writeFileSync(file, JSON.stringify(contents), { mode: 0o600 });
    const run = (target = file, optionalBrowserOrigin = false) =>
      spawnSync(
        process.execPath,
        ["-e", localPreviewAuthOriginReadProgram(target, optionalBrowserOrigin)],
        {
          encoding: "utf-8",
        },
      );
    try {
      const read = run();
      expect(read.status).toBe(0);
      expect(JSON.parse(read.stdout)).toBe(contents.BETTER_AUTH_URL);
      expect(read.stdout).not.toContain("private");
      expect(JSON.parse(run(path.join(directory, "absent.json"), true).stdout)).toBeNull();
      expect(run(file, true).status).not.toBe(0);
      const matching = { ...contents, APP_TEST_BASE_URL: contents.BETTER_AUTH_URL };
      writeFileSync(file, JSON.stringify(matching));
      expect(JSON.parse(run(file, true).stdout)).toBe(contents.BETTER_AUTH_URL);
      writeFileSync(file, JSON.stringify(contents));
      chmodSync(file, 0o644);
      expect(run().status).not.toBe(0);
      chmodSync(file, 0o600);
      const link = path.join(directory, "link.json");
      symlinkSync(file, link);
      expect(run(link).status).not.toBe(0);
      expect(readFileSync(file, "utf-8")).toBe(JSON.stringify(contents));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
  it("binds a bounded provider read to the server-derived state path and cancellation", async () => {
    const run = vi.fn<SandboxSession["run"]>(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify("https://old-owned-preview.vercel.run"),
        stderr: "",
      }),
    );
    const controller = new AbortController();
    await expect(
      readLocalPreviewAuthOrigin({
        appId: "supplier-spend",
        root: "/workspace/repository",
        sandbox: { run },
        signal: controller.signal,
      }),
    ).resolves.toBe("https://old-owned-preview.vercel.run");
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Assert the server-owned private runtime path, never open a caller path.
    expect(run.mock.calls[0]?.[0].command).toContain("/tmp/autograph-app-runtime/");
    expect(run.mock.calls[0]?.[0].abortSignal).toBe(controller.signal);
    run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify("https://customer.example"),
      stderr: "",
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
