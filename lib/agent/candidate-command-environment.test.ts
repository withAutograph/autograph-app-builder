import { describe, expect, it, vi } from "vitest";
import type { SandboxNetworkPolicy, SandboxProcess, SandboxSession } from "eve/sandbox";

import { withCandidateCommandEnvironment } from "./candidate-command-environment";

describe("candidate command environment", () => {
  it("preserves run options and results while selecting app-validation once", async () => {
    const result = { exitCode: 7, stderr: "provider detail", stdout: "output" };
    const run = vi.fn<SandboxSession["run"]>().mockResolvedValue(result);
    const spawn = vi.fn<SandboxSession["spawn"]>();
    const session = {
      run,
      spawn,
    };
    const wrapped = withCandidateCommandEnvironment(session);
    const abortSignal = new AbortController().signal;
    const options = {
      abortSignal,
      command: "mise run --no-deps --skip-tools app:check demo",
      env: { KEEP: "value", MISE_ENV: "node,app-validation,node" },
      workingDirectory: "/workspace/candidate",
    };

    await expect(wrapped.run(options)).resolves.toBe(result);

    expect(run).toHaveBeenCalledWith({
      ...options,
      env: { KEEP: "value", MISE_ENV: "node,node,app-validation" },
    });
    expect(run.mock.contexts[0]).toBe(session);
  });

  it("preserves spawn process handles, explicit profiles, and sandbox capabilities", async () => {
    const process: SandboxProcess = {
      kill: () => Promise.resolve(),
      stderr: new ReadableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      wait: () => Promise.resolve({ exitCode: 0 }),
    };
    const spawn = vi.fn<SandboxSession["spawn"]>().mockResolvedValue(process);
    const run = vi.fn<SandboxSession["run"]>();
    const setNetworkPolicy = vi.fn((_policy: SandboxNetworkPolicy) => Promise.resolve());
    const session = {
      id: "sandbox-id",
      run,
      setNetworkPolicy,
      spawn,
    };
    const wrapped = withCandidateCommandEnvironment(session);
    const abortSignal = new AbortController().signal;
    const options = {
      abortSignal,
      command: "mise exec --no-deps -- bun install --frozen-lockfile",
      env: { MISE_ENV: "node,app-validation,custom" },
      workingDirectory: "/workspace/candidate",
    };

    await expect(wrapped.spawn(options)).resolves.toBe(process);

    expect(spawn).toHaveBeenCalledWith({
      ...options,
      env: { MISE_ENV: "node,custom,app-validation" },
    });
    expect(wrapped.id).toBe("sandbox-id");
    await wrapped.setNetworkPolicy("allow-all");
    expect(setNetworkPolicy).toHaveBeenCalledWith("allow-all");
  });

  it("does not inherit host environment and preserves provider failures", async () => {
    const failure = new Error("provider command failure");
    const run = vi.fn<SandboxSession["run"]>().mockRejectedValue(failure);
    const session = { run, spawn: vi.fn<SandboxSession["spawn"]>() };
    const wrapped = withCandidateCommandEnvironment(session);

    await expect(wrapped.run({ command: "mise run format:app" })).rejects.toBe(failure);
    expect(run).toHaveBeenCalledWith({
      command: "mise run format:app",
      env: { MISE_ENV: "app-validation" },
    });
  });
});
