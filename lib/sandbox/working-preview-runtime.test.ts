import { setTimeout as delay } from "node:timers/promises";
import type { Sandbox } from "@vercel/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startWorkingPreview, stopWorkingPreviewCommand } from "./working-preview-runtime";

const ownership = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("./working-preview-ownership", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    previewOwnershipOperation: (_provider: unknown, operation: Record<string, unknown>) => {
      if (operation.kind === "read") {
        return Promise.resolve(ownership.current);
      }
      if (operation.kind === "claim") {
        if (ownership.current !== null) {
          return Promise.resolve({ claimed: false });
        }
        ownership.current = operation.attempt as Record<string, unknown>;
        return Promise.resolve({ claimed: true });
      }
      if (ownership.current?.attemptId !== operation.attemptId) {
        return Promise.reject(new Error("ownership changed"));
      }
      if (operation.kind === "release") {
        ownership.current = null;
      }
      if (operation.kind === "update") {
        ownership.current = { ...ownership.current, ...(operation.patch as object) };
      }
      return Promise.resolve(ownership.current);
    },
  };
});
beforeEach(() => {
  ownership.current = null;
});

const setup = () => {
  const events: string[] = [];
  const command = {
    cmdId: "command-1",
    kill: vi.fn(async () => {}),
    wait: vi.fn(() => Promise.resolve()),
  };
  const provider = {
    currentSession: () => ({ sessionId: "provider-1" }),
    domain: () => "https://preview.example",
    expiresAt: new Date(Date.now() + 30 * 60_000),
    extendTimeout: vi.fn(),
    fs: {
      mkdir: vi.fn(),
      readFile: vi.fn((file: string, _options?: { signal?: AbortSignal }) => {
        if (file.endsWith("listener-ready")) {
          events.push("bound");
          return Promise.resolve("ready");
        }
        return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
      }),
      writeFile: vi.fn((file: string) => {
        if (file.endsWith("access.json")) {
          events.push("activated");
        }
        return Promise.resolve();
      }),
    },
    getCommand: vi.fn(),
    runCommand: vi.fn(() => {
      events.push("spawn");
      return Promise.resolve(command);
    }),
    update: vi.fn(({ ports }: { ports: number[] }) => {
      events.push(ports.length === 0 ? "closed" : "exposed");
      return Promise.resolve();
    }),
  };
  const options = {
    appId: "example",
    command: { args: ["run", "dev"], executable: "pnpm" },
    cwd: "/workspace/repository",
    landingPath: "/example",
    port: 3000,
    provider: provider as unknown as Sandbox,
    sandboxId: "logical-1",
  };
  return { command, events, options, provider };
};

const launchResponse = () =>
  new Response(null, {
    headers: {
      location: "/example",
      "set-cookie": "__Host-autograph-preview=capability; Secure; HttpOnly; Path=/",
    },
    status: 303,
  });

describe("shared working preview startup", () => {
  it("binds with closed ingress and returns only an HTTP-verified implementation URL", async () => {
    const { events, options, provider } = setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(launchResponse())
      .mockResolvedValueOnce(
        new Response("<main>Working app</main>", { headers: { "content-type": "text/html" } }),
      );
    const result = await startWorkingPreview({ ...options, fetch: fetcher });
    expect(events).toEqual(["closed", "spawn", "bound", "exposed", "activated"]);
    expect(result.receipt.url).toMatch(
      /^https:\/\/preview\.example\/__autograph_preview_launch\?token=/u,
    );
    expect(result.receipt.status).toBe("ready");
    expect(provider.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ ports: [3000] }),
      expect.anything(),
    );
    expect(provider.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "node", detached: true }),
    );
  });

  it("carries application cookies across its authentication redirect before readiness", async () => {
    const { options } = setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(launchResponse())
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { location: "/welcome", "set-cookie": "app_session=nonce; Path=/; Secure" },
          status: 302,
        }),
      )
      .mockResolvedValueOnce(
        new Response("<main>Welcome</main>", { headers: { "content-type": "text/html" } }),
      );
    await startWorkingPreview({ ...options, fetch: fetcher });
    expect(fetcher.mock.calls[2][1]?.headers).toEqual({
      cookie: "__Host-autograph-preview=capability; app_session=nonce",
    });
  });

  it("does not publish a receipt for an inert or unavailable server and closes ingress even if kill fails", async () => {
    const { command, options, provider } = setup();
    command.kill.mockRejectedValueOnce(new Error("provider kill failed"));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      startWorkingPreview({ ...options, fetch: fetcher, readinessTimeoutMs: 100 }),
    ).rejects.toThrow("cleanup was incomplete");
    expect(command.kill).toHaveBeenCalled();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [] }, expect.anything());
  });

  it("does no provider work for an already cancelled turn", async () => {
    const { options, provider } = setup();
    await expect(
      startWorkingPreview({ ...options, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(provider.update).not.toHaveBeenCalled();
    expect(provider.runCommand).not.toHaveBeenCalled();
  });

  it("stops polling immediately when cancelled instead of resuming the stopped sandbox", async () => {
    const { command, options, provider } = setup();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => {
      controller.abort();
      return Promise.reject(controller.signal.reason);
    });
    await expect(
      startWorkingPreview({ ...options, fetch: fetcher, signal: controller.signal }),
    ).rejects.toThrow();
    // Only listener readiness ran; cancellation must not trigger a filesystem read.
    expect(provider.fs.readFile).toHaveBeenCalledTimes(1);
    expect(command.kill).toHaveBeenCalled();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [] }, expect.anything());
  });

  it("cleans up if writing runtime configuration fails before HTTP observation", async () => {
    const { command, options, provider } = setup();
    provider.fs.writeFile.mockRejectedValueOnce(new Error("filesystem unavailable"));
    await expect(startWorkingPreview(options)).rejects.toThrow("filesystem unavailable");
    expect(command.kill).not.toHaveBeenCalled();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [] }, expect.anything());
  });
});

describe("safe startup timeout diagnostics", () => {
  it("identifies listener startup without exposing a gateway or starting HTTP checks", async () => {
    const { options, provider, command } = setup();
    provider.fs.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      startWorkingPreview({ ...options, fetch: fetcher, readinessTimeoutMs: 100 }),
    ).rejects.toThrow(
      "timed out during listener startup. Last observation: Listener readiness marker absent",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(command.kill).toHaveBeenCalled();
  });

  it("reports application HTTP status without copying response bodies, cookies, or URLs", async () => {
    const { options } = setup();
    const fetcher = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        String(url).includes("/__autograph_preview_launch")
          ? launchResponse()
          : new Response("secret-response-body", {
              headers: { location: "/private?token=secret-token", "set-cookie": "secret-cookie" },
              status: 503,
            }),
      ),
    );
    const failure = await startWorkingPreview({
      ...options,
      fetch: fetcher,
      readinessTimeoutMs: 100,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toContain("application HTTP readiness. Last observation: Application HTTP 503");
    expect(message).not.toMatch(/secret|https:|token|cookie|preview\.example/u);
  });

  it("reports a safe transport class instead of an error message containing credentials", async () => {
    const { options } = setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("https://preview.example/?token=secret Cookie: private"));
    await expect(
      startWorkingPreview({ ...options, fetch: fetcher, readinessTimeoutMs: 100 }),
    ).rejects.toThrow(
      "application HTTP readiness. Last observation: Readiness transport TypeError.",
    );
  });
});

describe("preview command termination", () => {
  it("does not finish cleanup on signal acknowledgement before command termination", async () => {
    const exited = Promise.withResolvers<null>();
    const command = { kill: vi.fn(() => Promise.resolve()), wait: vi.fn(() => exited.promise) };
    let settled = false;
    const cleanup = stopWorkingPreviewCommand(
      command as unknown as Parameters<typeof stopWorkingPreviewCommand>[0],
    ).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(command.wait).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    exited.resolve(null);
    await cleanup;
    expect(settled).toBe(true);
    expect(command.kill).toHaveBeenCalledWith("SIGTERM", { abortSignal: expect.any(AbortSignal) });
    expect(command.wait).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it("reports unconfirmed termination and uses an independent live cleanup signal", async () => {
    const { command, options, provider } = setup();
    const cancellation = new AbortController();
    command.wait.mockRejectedValue(new Error("termination unconfirmed"));
    // Abort after the detached command has been obtained so cleanup owns it.
    provider.runCommand.mockImplementation(() => {
      cancellation.abort();
      return Promise.resolve(command);
    });
    await expect(startWorkingPreview({ ...options, signal: cancellation.signal })).rejects.toThrow(
      "cleanup was incomplete",
    );
    expect(command.wait).toHaveBeenCalledOnce();
  });
});

describe("startup ownership recovery", () => {
  it("does not launch or mutate ingress while a previous startup remains pending", async () => {
    const { options, provider } = setup();
    const response = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>(() => response.promise);
    const first = (async () => {
      try {
        return await startWorkingPreview({ ...options, fetch: fetcher, readinessTimeoutMs: 100 });
      } catch (error) {
        return error;
      }
    })();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const mutations = provider.update.mock.calls.length;
    await expect(startWorkingPreview(options)).rejects.toThrow("still pending");
    expect(provider.update.mock.calls).toHaveLength(mutations);
    expect(provider.runCommand).toHaveBeenCalledOnce();
    response.resolve(new Response(null, { status: 503 }));
    expect(await first).toBeInstanceOf(Error);
    expect(ownership.current).toBeNull();
  });

  it("retains ownership when dispatch did not return a command handle", async () => {
    const { options, provider } = setup();
    provider.runCommand.mockRejectedValue(new Error("dispatch response lost"));
    await expect(startWorkingPreview(options)).rejects.toThrow("cleanup was incomplete");
    expect(ownership.current).toMatchObject({ status: "cleanup-required" });
    await expect(startWorkingPreview(options)).rejects.toThrow("still pending");
    expect(provider.runCommand).toHaveBeenCalledOnce();
  });

  it("cannot close replacement ingress when an old startup fails late", async () => {
    const { options, provider, command } = setup();
    const fetcher = vi.fn<typeof fetch>(() => {
      ownership.current = {
        attemptId: "replacement",
        providerSessionId: "provider-1",
        status: "starting",
      };
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    await expect(
      startWorkingPreview({ ...options, fetch: fetcher, readinessTimeoutMs: 100 }),
    ).rejects.toThrow();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [3001] }, expect.anything());
    expect(ownership.current?.attemptId).toBe("replacement");
    expect(command.wait).toHaveBeenCalledOnce();
  });
});

it("bounds a provider readiness read by the stage deadline", async () => {
  const { options, provider, command } = setup();
  provider.fs.readFile.mockImplementation((file, readOptions) =>
    file.endsWith("listener-ready")
      ? delay(60_000, "ready", { signal: readOptions?.signal })
      : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
  );
  const started = Date.now();
  await expect(startWorkingPreview({ ...options, readinessTimeoutMs: 100 })).rejects.toThrow(
    "timed out during listener startup",
  );
  expect(Date.now() - started).toBeLessThan(1000);
  expect(command.wait).toHaveBeenCalledOnce();
}, 8000);

it("sanitizes startup error files and keeps the safe cause visible if cleanup fails", async () => {
  const { options, provider, command } = setup();
  provider.fs.readFile.mockImplementation((file) =>
    Promise.resolve(
      file.endsWith("listener-ready")
        ? "ready"
        : JSON.stringify({
            stderr:
              "Error: API_KEY=private-value request https://preview.example/?token=private-token failed",
          }),
    ),
  );
  command.wait.mockRejectedValue(new Error("termination not confirmed"));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  let observed: unknown;
  try {
    await startWorkingPreview({ ...options, fetch: fetcher, readinessTimeoutMs: 100 });
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(AggregateError);
  const { message } = observed as Error;
  expect(message).toContain("The application server failed to start");
  expect(message).toContain("Error:");
  expect(message).not.toMatch(/private-value|private-token|https:/u);
});
