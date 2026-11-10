import { sourceDeclaredToolchainActivationCommand } from "../repository/source-toolchain";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { appDescriptionSchema } from "../repository/app-description";
import path from "node:path";
import { localRuntimeEnvironmentPath } from "../repository/runtime-environment";
import { HostedTemplateFoundationUnavailableError } from "../repository/hosted-template-source-reconciliation";

import {
  appDeclaresLocalSetup,
  localPreviewExecutionCommand,
  localPreviewSetupCommand,
  prepareAppLocalPreview,
  prepareValidationLocalData,
} from "../../agent/tools/prepare-app-local-preview";

const descriptor = (backend: z.infer<typeof appDescriptionSchema>["backend"]) =>
  JSON.stringify({
    app: { id: "spend-review", routes: ["/spend-review"], workspacePath: "apps/spend-review" },
    backend,
    validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
    version: 1,
  });
const generated: z.infer<typeof appDescriptionSchema>["backend"] = {
  authorization: "declared-policy",
  kind: "generated-postgres",
  release: { artifactHash: "hash", directory: "release", id: "v1" },
  roles: ["member"],
  runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
  schemaReceipt: null,
};
const generatedWithReviewer: z.infer<typeof appDescriptionSchema>["backend"] = {
  ...generated,
  roles: ["member", "reviewer"],
};
const runtimeStateDirectory = path.posix.dirname(
  localRuntimeEnvironmentPath("/workspace/repository", "spend-review"),
);
const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

describe("private local preview setup", () => {
  it("discovers the source-derived backend rather than a demo setup declaration", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: descriptor(generated) });
    const input = { appId: "spend-review", root: "/workspace/repository", sandbox: { run } };
    expect(await appDeclaresLocalSetup(input)).toBe(true);
    expect(run).toHaveBeenCalledWith({
      command: "mise run --no-deps app:describe spend-review",
      workingDirectory: input.root,
    });
    run.mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor({ kind: "static" }) });
    expect(await appDeclaresLocalSetup(input)).toBe(false);
  });
  it("prepares authenticated data before validation and preserves setup failures", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "rustup: toolchain download failed",
        stdout: "",
      });
    await expect(
      prepareValidationLocalData({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { run },
      }),
    ).rejects.toThrow(/Validation could not prepare.*rustup: toolchain download failed/su);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith({
      command: `${sourceDeclaredToolchainActivationCommand()}\n${localPreviewExecutionCommand("spend-review")}`,
      env: {
        APP_RUNTIME_ROLES: "member",
        APP_RUNTIME_STATE_DIR: runtimeStateDirectory,
      },
      workingDirectory: "/workspace/repository",
    });
  });

  it("preserves an empty-role local runtime command failure", async () => {
    const stderr =
      "Authenticated runtime requires schema-declared roles or explicit accepted AppSpec roles in APP_RUNTIME_ROLES";
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: descriptor({ ...generated, authorization: "app-owned", roles: [] }),
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr,
        stdout: "",
      });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: 1, status: "failed", stderr });
  });
  it("retains a selected validation failure when local setup cannot prepare a role-less app", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: descriptor({ ...generated, authorization: "app-owned", roles: [] }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: descriptor({ ...generated, authorization: "app-owned", roles: [] }),
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "Authenticated runtime requires schema-declared roles",
        stdout: "",
      });
    await expect(
      prepareValidationLocalData({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { run },
      }),
    ).rejects.toThrow("Authenticated runtime requires schema-declared roles");
  });
  it.each([
    {
      backend: generated,
      stderr: "Authenticated runtime requires schema-declared roles",
    },
    {
      backend: { ...generated, roles: [] },
      stderr: "pg_ctl: could not start server",
    },
  ])("preserves other setup failures for $stderr", async ({ backend, stderr }) => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(backend) })
      .mockResolvedValueOnce({ exitCode: 2, stderr, stdout: "" });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: 2, status: "failed", stderr });
  });
  it("preserves successful empty-role runtime setup instead of imposing an authentication requirement", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: descriptor({ ...generated, authorization: "app-owned", roles: [] }),
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "Runtime ready" });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: 0, status: "prepared" });
    expect(run).toHaveBeenLastCalledWith({
      command: `${sourceDeclaredToolchainActivationCommand()}\n${localPreviewExecutionCommand("spend-review")}`,
      env: { APP_RUNTIME_STATE_DIR: runtimeStateDirectory },
      workingDirectory: "/workspace/repository",
    });
  });

  it("runs the selected app's repository task in its checkout", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "Local setup complete" });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenCalledWith({
      command: `${sourceDeclaredToolchainActivationCommand()}\n${localPreviewExecutionCommand("spend-review")}`,
      env: {
        APP_RUNTIME_ROLES: "member",
        APP_RUNTIME_STATE_DIR: runtimeStateDirectory,
      },
      workingDirectory: "/workspace/repository",
    });
    expect(localPreviewExecutionCommand("spend-review")).toContain(
      "mise run --no-deps app:runtime prepare spend-review local",
    );
    expect(result).toMatchObject({ exitCode: 0, status: "prepared" });
    expect(() => localPreviewSetupCommand("spend-review; deploy")).toThrow();
  });

  it("passes accepted roles and the private auth origin through the runtime environment", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generatedWithReviewer) })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "Local setup complete" });
    await prepareAppLocalPreview({
      appId: "spend-review",
      authOrigin: "https://spend-review.vercel.run",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenLastCalledWith({
      command: `${sourceDeclaredToolchainActivationCommand()}\n${localPreviewExecutionCommand("spend-review")}`,
      env: {
        APP_RUNTIME_AUTH_ORIGIN: "https://spend-review.vercel.run",
        APP_RUNTIME_ROLES: "member,reviewer",
        APP_RUNTIME_STATE_DIR: runtimeStateDirectory,
      },
      workingDirectory: "/workspace/repository",
    });
  });

  it("preserves actionable local database failures without leaking connection strings", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr:
          "pg_ctl: could not start server at postgres://postgres:secret@127.0.0.1:52016/spend_review",
        stdout: "",
      });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: 1, status: "failed" });
    expect(result.problem).toContain("local database startup");
    expect(result.stderr).toContain("pg_ctl");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("leaves static app setup free of Rust activation", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor({ kind: "static" }) })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "Runtime ready" });
    await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenLastCalledWith({
      command: localPreviewExecutionCommand("spend-review"),
      env: { APP_RUNTIME_STATE_DIR: runtimeStateDirectory },
      workingDirectory: "/workspace/repository",
    });
  });

  it("retains streamed setup failure diagnostics while redacting split credentials", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: descriptor(generated) });
    const spawn = vi.fn().mockResolvedValue({
      pid: 1,
      stdout: stream(["Auth setup\n"]),
      stderr: stream([
        "The recorded Auth origin cannot change outside the owned local preview handoff\npassword=split-",
        "secret postgres://user:private@host/db\n",
      ]),
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      wait: () => Promise.resolve({ exitCode: 1 }),
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      kill: () => Promise.resolve(),
    });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run, spawn },
      expectedPreviousAuthOrigin: "http://localhost:3000",
    });
    expect(result).toMatchObject({ exitCode: 1, status: "failed" });
    expect(result.stderr).toContain("The recorded Auth origin cannot change");
    expect(JSON.stringify(result)).not.toContain("split-secret");
    expect(JSON.stringify(result)).not.toContain("postgres://");
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest matcher inspects only the approved private environment key.
        env: expect.objectContaining({ APP_RUNTIME_PREVIOUS_AUTH_ORIGIN: "http://localhost:3000" }),
      }),
    );
    expect(run).toHaveBeenCalledOnce();
  });
  it("reports command-provider errors with a recovery action", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: descriptor(generated) })
      .mockRejectedValueOnce(new Error("Sandbox unavailable: token=secret"));
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: null, status: "failed" });
    expect(result.problem).toContain("sandbox command runner");
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });
});

describe("automatic retained foundation recovery", () => {
  const failed = {
    exitCode: 1,
    stderr: "Authenticated runtime requires schema-declared roles",
    stdout: "local setup started",
  };
  const harness = (
    outcomes: { exitCode: number; stderr: string; stdout: string }[],
    onSetup?: () => void,
  ) => {
    let setups = 0;
    const environments: (Record<string, string> | undefined)[] = [];
    const run = vi.fn(
      async ({ command, env }: { command: string; env?: Record<string, string> }) => {
        await Promise.resolve();
        if (command.includes("app:describe")) {
          return { exitCode: 0, stderr: "", stdout: descriptor({ ...generated, roles: [] }) };
        }
        setups += 1;
        environments.push(env);
        onSetup?.();
        const next = outcomes.shift();
        if (next === undefined) {
          throw new Error("Unexpected setup retry");
        }
        return next;
      },
    );
    return { run, environments, setups: () => setups };
  };
  it("retries the actual local task once after same-session foundation recovery", async () => {
    const h = harness([failed, { exitCode: 0, stderr: "", stdout: "runtime ready" }]);
    const recover = vi.fn(async () => await Promise.resolve(true));
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: h.run },
      recover,
    });
    expect(result).toMatchObject({ status: "prepared", exitCode: 0, stdout: "runtime ready" });
    expect(h.setups()).toBe(2);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(h.environments.every((env) => env?.APP_RUNTIME_ROLES === undefined)).toBe(true);
  });
  it("retains the failed command when no newer foundation is available", async () => {
    const h = harness([failed]);
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: h.run },
      recover: async () => await Promise.resolve(false),
    });
    expect(result).toMatchObject({ ...failed, status: "failed" });
    expect(h.setups()).toBe(1);
  });
  it("retains command evidence when the recovery service is unavailable", async () => {
    const h = harness([failed]);
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: h.run },
      recover: async () => await Promise.reject(new HostedTemplateFoundationUnavailableError()),
    });
    expect(result).toMatchObject({ ...failed, status: "failed" });
    expect(h.setups()).toBe(1);
  });
  it("propagates owner and integrity failures without a local fallback", async () => {
    const h = harness([failed]);
    const ownerChanged = new Error("current owner changed");
    const recover = async () => await Promise.reject(ownerChanged);
    await expect(
      prepareAppLocalPreview({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { run: h.run },
        recover,
      }),
    ).rejects.toBe(ownerChanged);
    expect(h.setups()).toBe(1);
  });
  it("returns the actual retried command failure without another recovery loop", async () => {
    const again = {
      exitCode: 2,
      stderr: "pg_ctl: could not start server",
      stdout: "new setup started",
    };
    const h = harness([failed, again]);
    const recover = vi.fn(async () => await Promise.resolve(true));
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: h.run },
      recover,
    });
    expect(result).toMatchObject({ ...again, status: "failed" });
    expect(h.setups()).toBe(2);
    expect(recover).toHaveBeenCalledTimes(1);
  });
  it("propagates cancellation before recovery dispatch", async () => {
    const abort = new AbortController();
    const h = harness([failed], () => {
      abort.abort();
    });
    const recover = vi.fn(async () => await Promise.resolve(true));
    await expect(
      prepareAppLocalPreview({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { run: h.run },
        signal: abort.signal,
        recover,
      }),
    ).rejects.toThrow();
    expect(recover).not.toHaveBeenCalled();
  });
  it("does not recover without an actual command exit failure", async () => {
    const h = harness([]);
    const recover = vi.fn(async () => await Promise.resolve(true));
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: h.run },
      recover,
    });
    expect(result).toMatchObject({ status: "failed", exitCode: null });
    expect(recover).not.toHaveBeenCalled();
  });
});
