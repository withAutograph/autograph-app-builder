import { createHash } from "node:crypto";
import { exec, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, chmod, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  deletesPrivateComputeCheck,
  verifyPrivateComputeCheckIntegrity,
} from "./private-compute-check-integrity";
import { PRIVATE_COMPUTE_CHECK_TASK } from "../sandbox/private-compute-profile";
import type { PrivateComputeProfile } from "../sandbox/private-compute-profile";

const hash = createHash("sha256").update(PRIVATE_COMPUTE_CHECK_TASK).digest("hex");
const profile: PrivateComputeProfile = {
  version: 1,
  id: "private-checks-16gib-v1",
  vcpus: 8,
  memoryMiB: 16_384,
  lintWorkers: 1,
  checkPolicy: {
    path: "apps/example/.config/mise/tasks/check",
    beforeSha256: hash,
    afterSha256: hash,
  },
  target: { sandboxId: "sandbox", workspaceDrive: "drive" },
  limits: {
    version: 1,
    teamId: "team_example",
    projectId: "prj_example",
    plan: "pro",
    maxVcpus: 8,
    limited: false,
    observedAt: "2026-11-04T00:00:00Z",
  },
};
describe("frozen private check policy", () => {
  it("rejects explicit deletion only for the selected frozen task", () => {
    const files = [{ operation: "delete" as const, path: profile.checkPolicy.path }];
    expect(deletesPrivateComputeCheck(profile, files)).toBe(true);
    expect(deletesPrivateComputeCheck(undefined, files)).toBe(false);
    expect(
      deletesPrivateComputeCheck(profile, [
        { operation: "delete", path: "apps/example/app/page.tsx" },
      ]),
    ).toBe(false);
  });
  it("does not dispatch a command for ordinary nonprofile validation", async () => {
    const run = vi.fn();
    expect(
      await verifyPrivateComputeCheckIntegrity({
        appId: "example",
        root: "/workspace/repository",
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
        profile: undefined,
        sandbox: { run },
      }),
    ).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("qualifies real mise file-task resolution and rejects effective TOML override, bytes and mode drift", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "builder-check-policy-")));
    execFileSync("/usr/bin/git", ["init", "--quiet", root]);
    await writeFile(path.join(root, "mise.toml"), "monorepo_root = true\n");
    const config = path.join(root, "apps/example/.config/mise");
    await mkdir(path.join(config, "tasks"), { recursive: true });
    await mkdir(path.join(root, "apps/example/empty-tasks"));
    await mkdir(path.join(root, ".config/mise"), { recursive: true });
    await writeFile(
      path.join(root, ".config/mise/config.toml"),
      '[settings]\nexperimental = true\n[monorepo]\nconfig_roots=["apps/*"]\n',
    );
    await writeFile(path.join(config, "config.toml"), "# discover app tasks\n");
    const globalConfig = path.join(root, "global-mise.toml");
    await writeFile(globalConfig, "# owned fixture global configuration\n");
    const task = path.join(root, profile.checkPolicy.path);
    await writeFile(task, PRIVATE_COMPUTE_CHECK_TASK, { mode: 0o755 });
    const selectedMise = process.env.APP_BUILDER_DEV_MISE_BIN;
    const miseDirectory =
      selectedMise !== undefined && selectedMise !== ""
        ? path.dirname(selectedMise)
        : path.join(os.homedir(), ".local/bin");
    const run: Parameters<typeof verifyPrivateComputeCheckIntegrity>[0]["sandbox"]["run"] = async (
      request,
    ) => {
      try {
        // oxlint-disable-next-line typescript/strict-void-return -- Node exec exposes a callback overload which promisify adapts to its actual result.
        const result = await promisify(exec)(
          request.command.replaceAll("/workspace/repository", root),
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${path.dirname(process.execPath)}:${miseDirectory}:${process.env.PATH ?? ""}:/usr/bin:/bin`,
              MISE_STATE_DIR: path.join(root, ".mise-state"),
              MISE_GLOBAL_CONFIG_FILE: globalConfig,
              MISE_TRUSTED_CONFIG_PATHS: root,
            },
          },
        );
        return { ...result, exitCode: 0 };
      } catch (error) {
        const observed = z.object({ stdout: z.string() }).safeParse(error);
        if (!observed.success) {
          throw error;
        }
        return { stdout: observed.data.stdout, stderr: "", exitCode: 1 };
      }
    };
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const check = () =>
      verifyPrivateComputeCheckIntegrity({
        appId: "example",
        root: "/workspace/repository",
        profile,
        sandbox: { run },
      });
    try {
      expect(await check()).toBe(true);
      // Older mise keeps a discovered file task when an inline command has the
      // same name. Select an empty include directory so this TOML command is a
      // genuine effective replacement on both the pinned CI and local CLI.
      await writeFile(
        path.join(config, "config.toml"),
        '[task_config]\nincludes=["empty-tasks"]\n[tasks.check]\nrun="vp check"\n',
      );
      const replacement = await run({
        command: "mise tasks info //apps/example:check --json",
        workingDirectory: "/workspace/repository",
      });
      expect(replacement.exitCode).toBe(0);
      expect(
        z
          .object({ source: z.string(), file: z.null(), run: z.array(z.string()) })
          .parse(JSON.parse(replacement.stdout)),
      ).toEqual({ file: null, run: ["vp check"], source: path.join(config, "config.toml") });
      expect(await check()).toBe(false);
      await writeFile(
        path.join(config, "config.toml"),
        '# unrelated config\n[env]\nEXAMPLE="value"\n',
      );
      expect(await check()).toBe(true);
      await chmod(task, 0o644);
      expect(await check()).toBe(false);
      await chmod(task, 0o755);
      await writeFile(task, "#!/bin/sh\nexit 0\n");
      expect(await check()).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
