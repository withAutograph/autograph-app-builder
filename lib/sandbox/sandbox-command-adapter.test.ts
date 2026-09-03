import { describe, expect, it, vi } from "vitest";

import type {
  SandboxBackend,
  SandboxBackendHandle,
  SandboxProcess,
  SandboxSession,
} from "eve/sandbox";
import { createBoundedSandboxBackend } from "./sandbox-command-adapter";

const stream = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });

function sessionFixture() {
  const spawn = vi.fn(
    async () =>
      ({
        stdout: stream("bounded"),
        stderr: stream(""),
        wait: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
      }) as unknown as SandboxProcess,
  );
  return {
    session: {
      id: "session_1",
      spawn,
      resolvePath: (path: string) => `/workspace/${path}`,
    } as unknown as SandboxSession,
    spawn,
  };
}

describe("production sandbox command adapter", () => {
  it("routes a live backend caller through authority and bounded spawn", async () => {
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
    const backend = createBoundedSandboxBackend({
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
      stdout: "bounded",
      stderr: "",
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith("session_1");
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining("setsid --wait bash"),
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not expose an unbounded authored spawn path", async () => {
    const fixture = sessionFixture();
    const backend = createBoundedSandboxBackend({
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
