import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, chmod, stat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { WorkingPreviewRuntime } from "../sandbox/working-preview-runtime";
import {
  PrivatePreviewBrowserPrerequisiteError,
  withPrivatePreviewBrowserAccess,
} from "./private-preview-browser-access";

const preview = (): WorkingPreviewRuntime => ({
  sandboxId: "sandbox",
  providerSessionId: "provider",
  commandId: "command",
  receipt: {
    appId: "example",
    status: "ready",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    verifiedAt: new Date().toISOString(),
    url: "https://preview.vercel.run/__autograph_preview_launch?token=fixture-owner-capability",
  },
});
describe("owned private browser authority", () => {
  it.each(["app", "sandbox", "expired", "url"])(
    "rejects %s mismatch before private I/O",
    async (kind) => {
      const current = preview();
      if (kind === "app") {
        current.receipt.appId = "foreign";
      }
      if (kind === "sandbox") {
        current.sandboxId = "foreign";
      }
      if (kind === "expired") {
        current.receipt.expiresAt = new Date(0).toISOString();
      }
      if (kind === "url") {
        current.receipt.url = "https://foreign.test/ordinary";
      }
      const run = vi.fn();
      const writeTextFile = vi.fn();
      await expect(
        withPrivatePreviewBrowserAccess({
          appId: "example",
          root: "/workspace/repository",
          sandboxId: "sandbox",
          preview: current,
          sandbox: { run, writeTextFile },
          assertCurrent: () => {},
          operation: () => Promise.resolve("unused"),
        }),
      ).rejects.toBeInstanceOf(PrivatePreviewBrowserPrerequisiteError);
      expect(run).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
    },
  );
  it("uploads only through the private file API, seals modes, forwards only a path and removes its exact file", async () => {
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Own a random isolated directory, then remove only that test namespace.
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "builder-preview-authority-")),
    );
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Translate only the exact test-owned runtime prefix into the isolated directory.
    const translate = (value: string) => value.replaceAll("/tmp/autograph-app-runtime", directory);
    const commands: string[] = [];
    const run: Parameters<typeof withPrivatePreviewBrowserAccess>[0]["sandbox"]["run"] = async (
      input,
    ) => {
      commands.push(input.command);
      // oxlint-disable-next-line typescript/strict-void-return -- Node's callback execFile is adapted by promisify to its result.
      const result = await promisify(execFile)(process.execPath, [
        "-e",
        `require('node:child_process').execFileSync('/bin/sh',['-c',${JSON.stringify(translate(input.command))}],{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(path.dirname(process.execPath))}+':/usr/bin:/bin'}})`,
      ]);
      return { ...result, exitCode: 0 };
    };
    const writeTextFile: NonNullable<
      Parameters<typeof withPrivatePreviewBrowserAccess>[0]["sandbox"]["writeTextFile"]
    > = async (input) => {
      await writeFile(translate(input.path), input.content);
      await chmod(translate(input.path), 0o644);
    };
    let actualFile = "";
    try {
      const result = await withPrivatePreviewBrowserAccess({
        appId: "example",
        root: "/workspace/repository",
        sandboxId: "sandbox",
        preview: preview(),
        sandbox: { run, writeTextFile },
        assertCurrent: () => {},
        operation: async (environment) => {
          actualFile = translate(environment.APP_TEST_PREVIEW_AUTHORITY_FILE ?? "");
          expect(Object.keys(environment)).toEqual([
            "APP_TEST_PREVIEW_AUTHORITY_FILE",
            "APP_TEST_BASE_URL",
          ]);
          expect(environment.APP_TEST_BASE_URL).toBe("https://preview.vercel.run");
          expect(environment.APP_TEST_PREVIEW_AUTHORITY_FILE).not.toContain("capability");
          const mode = await stat(actualFile);
          // oxlint-disable-next-line eslint/no-bitwise -- Verify the actual POSIX permission bits of the retained private file.
          expect(mode.mode & 0o777).toBe(0o600);
          expect(await readFile(actualFile, "utf-8")).toContain("fixture-owner-capability");
          return "executed";
        },
      });
      expect(result).toBe("executed");
      expect(commands.join("\n")).not.toContain("fixture-owner-capability");
      await expect(stat(actualFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
  it.each(["source-changed", "cancelled"])(
    "stops after private upload when %s and cleans only its own file",
    async (kind) => {
      const controller = new AbortController();
      let current = true;
      const run = vi
        .fn<Parameters<typeof withPrivatePreviewBrowserAccess>[0]["sandbox"]["run"]>()
        .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
      const writeTextFile = vi.fn(() => {
        if (kind === "cancelled") {
          controller.abort();
        } else {
          current = false;
        }
        return Promise.resolve();
      });
      const operation = vi.fn();
      await expect(
        withPrivatePreviewBrowserAccess({
          appId: "example",
          root: "/workspace/repository",
          sandboxId: "sandbox",
          preview: preview(),
          sandbox: { run, writeTextFile },
          signal: controller.signal,
          assertCurrent: () => {
            if (!current) {
              throw new PrivatePreviewBrowserPrerequisiteError();
            }
          },
          operation,
        }),
      ).rejects.toBeDefined();
      expect(operation).not.toHaveBeenCalled();
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(run.mock.calls.at(-1)?.[0].command).toContain("remove");
      expect(
        run.mock.calls.some(([input]) => input.command.includes("fixture-owner-capability")),
      ).toBe(false);
    },
  );

  it("cancels before any I/O and never dispatches a browser operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    const operation = vi.fn();
    await expect(
      withPrivatePreviewBrowserAccess({
        appId: "example",
        root: "/workspace/repository",
        sandboxId: "sandbox",
        preview: preview(),
        sandbox: { run, writeTextFile: vi.fn() },
        signal: controller.signal,
        assertCurrent: () => {},
        operation,
      }),
    ).rejects.toBeDefined();
    expect(run).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });
});
