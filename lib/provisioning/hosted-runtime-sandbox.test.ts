/* oxlint-disable eslint/require-await -- Promise-returning SDK fixtures. */
import { z } from "zod";

import { describe, expect, it, vi } from "vitest";

import { createHostedRuntimeSandboxExecutor } from "./hosted-runtime-sandbox";
import { HostedRuntimeCommandError } from "./hosted-runtime-service";

describe("protected hosted runtime Sandbox transport", () => {
  it("allocates a private checkpoint with prepare's checkpoint-only flag before installation", async () => {
    const stdout = vi.fn();
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout });
    const executor = createHostedRuntimeSandboxExecutor({
      appId: "spend-review",
      provider: {
        fs: { mkdir: vi.fn(), readFile: vi.fn(), readdir: vi.fn() },
        runCommand,
        writeFiles: vi.fn(),
      },
      root: "/workspace/repository",
      stateDirectory: "/private-runtime",
    });

    expect(
      await executor.run({
        clusterUrl: "synthetic-secret-endpoint",
        operation: "checkpoint",
        productionDatabaseIdentity: "ep-production.aws.neon.tech/neondb",
        runtimeId: "owned_runtime",
      }),
    ).toBeNull();
    const call = z
      .object({
        args: z.array(z.string()),
        cmd: z.string(),
        env: z.record(z.string(), z.string()),
      })
      .parse(runCommand.mock.calls[0]?.[0]);
    expect(call.cmd).toBe("mise");
    expect(call.args).toEqual([
      "run",
      "app:runtime",
      "prepare",
      "spend-review",
      "preview",
      "--",
      "--checkpoint-only",
    ]);
    expect(call.env.APP_RUNTIME_STATE_DIR).toBe("/private-runtime");
    expect(call.env.APP_RUNTIME_CLUSTER_DATABASE_URL).toBe("synthetic-secret-endpoint");
    expect(JSON.stringify(call.args)).not.toContain("synthetic-secret");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("passes secrets through SDK env, keeps command arguments ordinary, and projects only parsed proof", async () => {
    const proof = {
      actors: 8,
      artifactHash: "a".repeat(64),
      authenticatedBehavior: "unassessed",
      releaseId: "release_1",
      tenants: 2,
    };
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: async () =>
        `private log\n${JSON.stringify({ ...proof, privateUnexpectedField: "do-not-project" })}\n`,
    });
    const provider = {
      fs: { mkdir: vi.fn(), readFile: vi.fn(), readdir: vi.fn() },
      runCommand,
      writeFiles: vi.fn(),
    };
    const executor = createHostedRuntimeSandboxExecutor({
      appId: "spend-review",
      authOrigin: "https://owned.vercel.run",
      provider,
      roles: ["requester", "reviewer"],
      root: "/workspace/repository",
      stateDirectory: "/private-runtime",
    });
    const result = await executor.run({
      clusterUrl: "synthetic-secret-endpoint",
      operation: "verify",
      productionDatabaseIdentity: "ep-production.aws.neon.tech/neondb",
      runtimeId: "owned_runtime",
    });
    expect(result).toEqual(proof);
    const call = z
      .object({ args: z.array(z.string()), cmd: z.string(), env: z.record(z.string(), z.string()) })
      .parse(runCommand.mock.calls[0]?.[0]);
    expect(call.args).toEqual(["run", "app:runtime", "verify", "spend-review", "preview"]);
    expect(call.cmd).toBe("mise");
    expect(call.env.APP_RUNTIME_CLUSTER_DATABASE_URL).toBe("synthetic-secret-endpoint");
    expect(call.env.APP_RUNTIME_ROLES).toBe("requester,reviewer");
    expect(call.env.APP_RUNTIME_STATE_DIR).toBe("/private-runtime");
    expect(call.env.AUTH_PRODUCTION_DATABASE_IDENTITY).toBe("ep-production.aws.neon.tech/neondb");
    expect(call.env.VERCEL_ENV).toBeUndefined();
    expect(call.env.VERCEL_DEPLOYMENT_ID).toBeUndefined();
    expect(JSON.stringify(call.args)).not.toContain("synthetic-secret");
  });

  it("returns only the operation and exit status when a command fails", async () => {
    const stdout = vi.fn();
    const provider = {
      fs: { mkdir: vi.fn(), readFile: vi.fn(), readdir: vi.fn() },
      runCommand: vi.fn().mockResolvedValue({ exitCode: 7, stdout }),
      writeFiles: vi.fn(),
    };
    const executor = createHostedRuntimeSandboxExecutor({
      appId: "spend-review",
      authOrigin: "https://owned.vercel.run",
      provider,
      root: "/workspace/repository",
      stateDirectory: "/private-runtime",
    });
    await expect(
      executor.run({
        clusterUrl: "synthetic-secret-endpoint",
        operation: "prepare",
        productionDatabaseIdentity: "ep-production.aws.neon.tech/neondb",
        runtimeId: "owned_runtime",
      }),
    ).rejects.toEqual(new HostedRuntimeCommandError("prepare", 7));
    expect(stdout).not.toHaveBeenCalled();
  });
});
