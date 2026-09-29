/* oxlint-disable eslint/require-await, sonarjs/publicly-writable-directories -- Synthetic SDK capabilities and owned temporary fixtures. */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  installerSourceArchive,
  installerSourceRestore,
  withHostedInstallerSandbox,
} from "./hosted-runtime-installer";

const capabilities = () => {
  const source = {
    fs: {
      readFile: vi.fn().mockResolvedValue(Buffer.from("bounded source chunk")),
      readdir: vi.fn().mockResolvedValue(["000000000001.part", "source.tar", "000000000000.part"]),
      rm: vi.fn(),
    },
    name: "owned-application-sandbox",
    runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
  };
  const control = {
    delete: vi.fn(),
    extendTimeout: vi.fn(),
    fs: { mkdir: vi.fn(), readFile: vi.fn(), readdir: vi.fn(), rm: vi.fn() },
    runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
    writeFiles: vi.fn(),
  };
  const create = vi.fn().mockResolvedValue(control);
  return { control, create, source };
};

describe("isolated hosted installer capability", () => {
  it("copies exact live source in ordered bounded chunks before granting installer access", async () => {
    const fixture = capabilities();
    const result = await withHostedInstallerSandbox({
      ...fixture,
      root: "/workspace/repository",
      run: async (control) => {
        expect(control).toBe(fixture.control);
        expect(fixture.control.runCommand).toHaveBeenCalledWith(
          expect.objectContaining({ cmd: "node" }),
        );
        expect(fixture.control.writeFiles).toHaveBeenCalledTimes(2);
        return { status: "verified" };
      },
    });
    expect(result).toEqual({ status: "verified" });
    expect(fixture.create).toHaveBeenCalledWith(fixture.source.name, expect.any(AbortSignal));
    expect(
      fixture.source.fs.readFile.mock.calls.map(([file]) => path.basename(z.string().parse(file))),
    ).toEqual(["000000000000.part", "000000000001.part"]);
    expect(JSON.stringify(fixture.source.runCommand.mock.calls)).not.toContain(
      "APP_RUNTIME_CLUSTER_DATABASE_URL",
    );
    expect(fixture.control.delete).toHaveBeenCalledWith(
      expect.objectContaining({ deleteOrphanSnapshots: true }),
    );
  });

  it("deletes isolated control compute even when its approved installer task fails", async () => {
    const fixture = capabilities();
    await expect(
      withHostedInstallerSandbox({
        ...fixture,
        root: "/workspace/repository",
        run: async () => {
          throw new Error("installer failed");
        },
      }),
    ).rejects.toThrow("installer failed");
    expect(fixture.control.delete).toHaveBeenCalledTimes(1);
    expect(fixture.source.fs.rm).toHaveBeenCalled();
  });

  it.each(["archive", "restore"])(
    "never grants credentials after a failed %s transfer",
    async (stage) => {
      const fixture = capabilities();
      (stage === "archive" ? fixture.source : fixture.control).runCommand.mockResolvedValue({
        exitCode: 1,
      });
      const run = vi.fn();
      await expect(
        withHostedInstallerSandbox({ ...fixture, root: "/workspace/repository", run }),
      ).rejects.toMatchObject({ code: "provider_unavailable" });
      expect(run).not.toHaveBeenCalled();
      if (stage === "restore") {
        expect(fixture.control.delete).toHaveBeenCalled();
      }
    },
  );

  it("does not report successful preparation when isolated compute cleanup fails", async () => {
    const fixture = capabilities();
    fixture.control.delete.mockRejectedValue(new Error("provider unavailable"));
    await expect(
      withHostedInstallerSandbox({
        ...fixture,
        root: "/workspace/repository",
        run: async () => ({ status: "prepared" }),
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("aborts the private installer and deletes compute when its provider lease cannot renew", async () => {
    vi.useFakeTimers();
    try {
      const fixture = capabilities();
      fixture.control.extendTimeout.mockRejectedValue(new Error("provider capacity unavailable"));
      const ready = Promise.withResolvers<true>();
      const operation = withHostedInstallerSandbox({
        ...fixture,
        root: "/workspace/repository",
        run: async (_control, signal) => {
          const stopped = Promise.withResolvers<true>();
          signal.addEventListener(
            "abort",
            () => {
              stopped.reject(z.instanceof(Error).parse(signal.reason));
            },
            { once: true },
          );
          ready.resolve(true);
          await stopped.promise;
        },
      });
      const failed = expect(operation).rejects.toMatchObject({ code: "provider_unavailable" });
      await ready.promise;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await failed;
      expect(fixture.control.extendTimeout).toHaveBeenCalledWith(5 * 60_000, expect.anything());
      expect(fixture.control.delete).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("transfers current CUE, release bytes and external symlink dependencies without a total file cap", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "builder-installer-source-"));
    const root = path.join(directory, "source");
    const dependencies = path.join(directory, "dependencies");
    const staging = path.join(directory, "transfer");
    try {
      await mkdir(path.join(root, "schema"), { recursive: true });
      await mkdir(path.join(root, ".next"));
      await mkdir(dependencies);
      await writeFile(path.join(root, "schema", "app.cue"), "current checked CUE");
      await writeFile(path.join(root, "schema", "release.json"), "current checked release");
      await writeFile(path.join(root, ".next", "stale"), "derived cache");
      await writeFile(path.join(dependencies, "runtime.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
      await symlink(dependencies, path.join(root, "node_modules"));
      await symlink(root, path.join(dependencies, "workspace"));
      const archived = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", installerSourceArchive, root, staging],
        { encoding: "utf-8" },
      );
      expect(archived.status, archived.stderr).toBe(0);
      const chunks = await readdir(staging);
      expect(chunks.filter((name) => name.endsWith(".part"))).toHaveLength(2);
      await rm(root, { force: true, recursive: true });
      await rm(dependencies, { force: true, recursive: true });
      const restored = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", installerSourceRestore, staging],
        { encoding: "utf-8" },
      );
      expect(restored.status, restored.stderr).toBe(0);
      expect(await readFile(path.join(root, "schema", "app.cue"), "utf-8")).toBe(
        "current checked CUE",
      );
      expect(await readFile(path.join(root, "schema", "release.json"), "utf-8")).toBe(
        "current checked release",
      );
      expect(await readFile(path.join(root, "node_modules", "runtime.bin"))).toHaveLength(
        9 * 1024 * 1024,
      );
      await expect(readFile(path.join(root, ".next", "stale"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
