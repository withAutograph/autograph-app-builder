import { z } from "zod";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  link,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPrivateComputeCheckPolicy } from "./private-compute-check-policy";
import {
  LEGACY_PRIVATE_COMPUTE_CHECK_TASK,
  PRIVATE_COMPUTE_CHECK_TASK,
  privateComputeProfileSchema,
} from "../sandbox/private-compute-profile";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const profile = () =>
  privateComputeProfileSchema.parse({
    checkPolicy: {
      afterSha256: hash(PRIVATE_COMPUTE_CHECK_TASK),
      beforeSha256: hash(LEGACY_PRIVATE_COMPUTE_CHECK_TASK),
      path: "apps/example/.config/mise/tasks/check",
    },
    id: "private-checks-16gib-v1",
    limits: {
      limited: false,
      maxVcpus: 8,
      observedAt: "2026-11-03T12:00:00.000Z",
      plan: "pro",
      projectId: "prj_owned",
      teamId: "team_owned",
      version: 1,
    },
    lintWorkers: 1,
    memoryMiB: 16_384,
    target: { sandboxId: "same", workspaceDrive: "same-drive" },
    vcpus: 8,
    version: 1,
  });
const modeOf = async (file: string) => {
  const observed = await stat(file);
  return observed.mode % 4096;
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});
const fixture = async (content = LEGACY_PRIVATE_COMPUTE_CHECK_TASK, mode = 0o755) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "builder-check-policy-")));
  roots.push(root);
  const file = path.join(root, profile().checkPolicy.path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { mode });
  const calls: string[] = [];
  const sandbox = {
    run: async (input: { command: string; workingDirectory?: string }) => {
      calls.push(input.command);
      expect(input.workingDirectory).toBe("/workspace/repository");
      try {
        const stdout = execFileSync(
          "/bin/sh",
          [
            "-c",
            input.command
              .replaceAll("/workspace/repository", root)
              .replace(/^node /u, `${JSON.stringify(process.execPath)} `),
          ],
          { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        );
        return { exitCode: 0, stderr: "", stdout };
      } catch (error) {
        const output = z.object({ stdout: z.string() }).safeParse(error);
        return {
          exitCode: 1,
          stderr: "",
          stdout: output.success ? output.data.stdout : "",
        };
      }
    },
  };
  return {
    calls,
    file,
    input: { applyRoot: "/workspace/repository", profile: profile(), sandbox },
    root,
    sandbox,
  };
};
describe("reviewed private check task", () => {
  it("installs approved bytes with executable mode and verifies a replay", async () => {
    const f = await fixture();
    await applyPrivateComputeCheckPolicy(f.input);
    expect(await readFile(f.file, "utf-8")).toBe(PRIVATE_COMPUTE_CHECK_TASK);
    expect(await modeOf(f.file)).toBe(0o755);
    await applyPrivateComputeCheckPolicy(f.input);
    expect(f.calls).toHaveLength(2);
  });
  it("repairs the exact already-installed policy's lost executable bit on normal replay", async () => {
    const f = await fixture(PRIVATE_COMPUTE_CHECK_TASK, 0o644);
    await applyPrivateComputeCheckPolicy(f.input);
    expect(await modeOf(f.file)).toBe(0o755);
    expect(await readFile(f.file, "utf-8")).toBe(PRIVATE_COMPUTE_CHECK_TASK);
  });
  it("preserves custom or concurrently changed content", async () => {
    const original = "#!/bin/sh\nexec custom-security-check\n";
    const f = await fixture(original);
    await expect(applyPrivateComputeCheckPolicy(f.input)).rejects.toThrow("Apply is incomplete");
    expect(await readFile(f.file, "utf-8")).toBe(original);
    expect(await modeOf(f.file)).toBe(0o755);
  });
  it("does not recreate an absent task or follow a symlink", async () => {
    const f = await fixture();
    await rm(f.file);
    await expect(applyPrivateComputeCheckPolicy(f.input)).rejects.toThrow("Apply is incomplete");
    await expect(stat(f.file)).rejects.toThrow();
    const target = path.join(f.root, "other");
    await writeFile(target, LEGACY_PRIVATE_COMPUTE_CHECK_TASK, { mode: 0o644 });
    await symlink(target, f.file);
    await expect(applyPrivateComputeCheckPolicy(f.input)).rejects.toThrow("Apply is incomplete");
    expect(await modeOf(target)).toBe(0o644);
    expect(await readFile(target, "utf-8")).toBe(LEGACY_PRIVATE_COMPUTE_CHECK_TASK);
  });
  it("rejects hardlinks and a symlinked parent without changing their target", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "linked-check");
    await link(f.file, alias);
    await expect(applyPrivateComputeCheckPolicy(f.input)).rejects.toThrow("unlinked regular file");
    expect(await readFile(alias, "utf-8")).toBe(LEGACY_PRIVATE_COMPUTE_CHECK_TASK);
    await rm(alias);
    const realTasks = path.join(f.root, "real-tasks");
    await mkdir(realTasks);
    await writeFile(path.join(realTasks, "check"), LEGACY_PRIVATE_COMPUTE_CHECK_TASK);
    await rm(path.dirname(f.file), { recursive: true });
    await symlink(realTasks, path.dirname(f.file));
    await expect(applyPrivateComputeCheckPolicy(f.input)).rejects.toThrow("unlinked regular file");
    expect(await readFile(path.join(realTasks, "check"), "utf-8")).toBe(
      LEGACY_PRIVATE_COMPUTE_CHECK_TASK,
    );
  });
  it.each([
    "",
    '{"sha256":"wrong","mode":"755"}',
    JSON.stringify({ mode: "644", sha256: hash(PRIVATE_COMPUTE_CHECK_TASK) }),
  ])("rejects missing or invalid immediate readback %s", async (stdout) => {
    await expect(
      applyPrivateComputeCheckPolicy({
        applyRoot: "/workspace/repository",
        profile: profile(),
        sandbox: { run: async () => ({ exitCode: 0, stderr: "", stdout }) },
      }),
    ).rejects.toThrow("readback");
  });
  it("propagates owner cancellation without acknowledging a successful apply", async () => {
    await expect(
      applyPrivateComputeCheckPolicy({
        applyRoot: "/workspace/repository",
        profile: profile(),
        sandbox: {
          run: async () => {
            throw new Error("owner cancelled");
          },
        },
      }),
    ).rejects.toThrow("owner cancelled");
  });
  it("carries cancellation into the command and rejects a cancelled completion", async () => {
    const controller = new AbortController();
    let calls = 0;
    const input = {
      abortSignal: controller.signal,
      applyRoot: "/workspace/repository",
      profile: profile(),
      sandbox: {
        run: async (options: { abortSignal?: AbortSignal }) => {
          calls += 1;
          expect(options.abortSignal).toBe(controller.signal);
          controller.abort(new Error("cancelled during install"));
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({ mode: "755", sha256: hash(PRIVATE_COMPUTE_CHECK_TASK) }),
          };
        },
      },
    };
    await expect(applyPrivateComputeCheckPolicy(input)).rejects.toThrow("cancelled during install");
    await expect(applyPrivateComputeCheckPolicy(input)).rejects.toThrow("cancelled during install");
    expect(calls).toBe(1);
  });
  it("rejects foreign roots and escaping paths before dispatch", async () => {
    const f = await fixture();
    await expect(
      applyPrivateComputeCheckPolicy({ ...f.input, applyRoot: "/workspace/other" }),
    ).rejects.toThrow("owned application checkout");
    await expect(
      applyPrivateComputeCheckPolicy({
        ...f.input,
        profile: { ...profile(), checkPolicy: { ...profile().checkPolicy, path: "../../outside" } },
      }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});
