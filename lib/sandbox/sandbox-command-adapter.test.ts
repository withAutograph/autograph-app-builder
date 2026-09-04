import { describe, expect, it, vi } from "vitest";

import type {
  SandboxBackend,
  SandboxBackendHandle,
  SandboxSession,
} from "eve/sandbox";
import { createAuthorizedSandboxBackend } from "./sandbox-command-adapter";

function sessionFixture() {
  const run = vi.fn(async () => ({
    exitCode: 0,
    stdout: "provider output",
    stderr: "",
  }));
  const spawn = vi.fn();
  return {
    session: {
      id: "session_1",
      spawn,
      run,
      resolvePath: (path: string) => `/workspace/${path}`,
    } as unknown as SandboxSession,
    run,
    spawn,
  };
}

describe("production sandbox command adapter", () => {
  it("routes a live backend caller through authority and Vercel's command transport", async () => {
    const fixture = sessionFixture();
    const authorize = vi.fn(async () => undefined);
    const handle = {
      session: fixture.session,
      useSessionFn: async () => fixture.session,
      captureState: async () => ({
        backendName: "fixture",
        metadata: {},
        sessionKey: "session_1",
      }),
      stop: async () => undefined,
      shutdown: async () => undefined,
    } satisfies SandboxBackendHandle;
    const backend = createAuthorizedSandboxBackend({
      backend: {
        name: "fixture",
        create: async () => handle,
        prewarm: async () => ({ reused: true }),
      } satisfies SandboxBackend,
      authorizeSessionCommand: authorize,
    });
    const live = await backend.create({
      runtimeContext: { appRoot: process.cwd() },
      sessionKey: "session_1",
      templateKey: null,
    });
    await expect(live.session.run({ command: "true" })).resolves.toEqual({
      exitCode: 0,
      stdout: "provider output",
      stderr: "",
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith("session_1");
    expect(fixture.run).toHaveBeenCalledWith({ command: "true" });
  });

  it("does not expose an unbounded authored spawn path", async () => {
    const fixture = sessionFixture();
    const backend = createAuthorizedSandboxBackend({
      backend: {
        name: "fixture",
        create: async () =>
          ({
            session: fixture.session,
            useSessionFn: async () => fixture.session,
            captureState: async () => ({
              backendName: "fixture",
              metadata: {},
              sessionKey: "session_1",
            }),
            stop: async () => undefined,
            shutdown: async () => undefined,
          }) satisfies SandboxBackendHandle,
        prewarm: async () => ({ reused: true }),
      } satisfies SandboxBackend,
      authorizeSessionCommand: async () => undefined,
    });
    const live = await backend.create({
      runtimeContext: { appRoot: process.cwd() },
      sessionKey: "session_1",
      templateKey: null,
    });
    await expect(live.session.spawn({ command: "server" })).rejects.toThrow(
      "Direct authored sandbox spawn is disabled",
    );
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});
