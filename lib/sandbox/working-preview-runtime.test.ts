import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "@vercel/sandbox";
import { describe, expect, it, vi } from "vitest";

import { startWorkingPreview, stopWorkingPreviewCommand } from "./working-preview-runtime";
import type {
  PreviewAttempt,
  previewOwnershipOperation as defaultOwnershipOperation,
} from "./working-preview-ownership";

type OwnershipOperation = Parameters<typeof defaultOwnershipOperation>[1];

const preview = async (options: Parameters<typeof startWorkingPreview>[0]) =>
  await startWorkingPreview(options);
const requestUrl = (input: RequestInfo | URL): string => {
  if (input instanceof Request) {
    return input.url;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input;
};

const setup = () => {
  let ownership: PreviewAttempt | null = null;
  const events: string[] = [];
  const command = {
    cmdId: "command-1",
    exitCode: null,
    kill: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
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
          return "ready";
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
      writeFile: vi.fn((file: string) => {
        if (file.endsWith("access.json")) {
          events.push("activated");
        }
      }),
    },
    getCommand: vi.fn(async () => await Promise.resolve(command)),
    runCommand: vi.fn(async () => {
      events.push("spawn");
      return await Promise.resolve(command);
    }),
    update: vi.fn(async ({ ports }: { ports: number[] }) => {
      events.push(ports.length === 0 ? "closed" : "exposed");
      await Promise.resolve();
    }),
  };
  const options = {
    appId: "example",
    command: { args: ["run", "dev"], executable: "pnpm" },
    cwd: "/workspace/repository",
    landingPath: "/example",
    ownershipOperation: async (
      _provider: Parameters<typeof defaultOwnershipOperation>[0],
      operation: OwnershipOperation,
    ) => {
      await Promise.resolve();
      if (operation.kind === "read") {
        return ownership;
      }
      if (operation.kind === "claim") {
        if (ownership !== null) {
          return { attempt: ownership, claimed: false };
        }
        ownership = operation.attempt;
        return { attempt: ownership, claimed: true };
      }
      if (
        ownership?.attemptId !== operation.attemptId ||
        ownership.providerSessionId !== operation.providerSessionId
      ) {
        throw new Error("ownership changed");
      }
      if (operation.kind === "release") {
        ownership = null;
      }
      if (operation.kind === "update") {
        ownership = { ...ownership, ...operation.patch };
      }
      return ownership;
    },
    port: 3000,
    provider,
    sandboxId: "logical-1",
  };
  const state = {
    get ownership() {
      return ownership;
    },
    set ownership(value: PreviewAttempt | null) {
      ownership = value;
    },
  };
  return { command, events, options, provider, state };
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
  it("releases the exact ready startup if prior artifact authority changed before return", async () => {
    const { command, options, provider, state } = setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(launchResponse())
      .mockResolvedValueOnce(
        new Response("<main>Ready</main>", { headers: { "content-type": "text/html" } }),
      );
    await expect(
      preview({
        ...options,
        assertCurrent: () => {
          if (state.ownership?.status === "ready") {
            throw new Error("Prior artifact changed.");
          }
        },
        fetch: fetcher,
      }),
    ).rejects.toThrow("Prior artifact changed.");
    expect(command.kill).toHaveBeenCalledOnce();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [] }, expect.anything());
    expect(state.ownership).toBeNull();
  });

  it("binds with closed ingress and returns only an HTTP-verified implementation URL", async () => {
    const { events, options, provider } = setup();
    const sandboxExpiresAt = provider.expiresAt;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(launchResponse())
      .mockResolvedValueOnce(
        new Response("<main>Working app</main>", { headers: { "content-type": "text/html" } }),
      );
    const result = await preview({ ...options, fetch: fetcher });
    expect(events).toEqual(["closed", "spawn", "bound", "exposed", "activated"]);
    expect(result.receipt.url).toMatch(
      /^https:\/\/preview\.example\/__autograph_preview_launch\?token=/u,
    );
    expect(result.receipt.status).toBe("ready");
    expect(result.receipt.expiresAt).toBe(sandboxExpiresAt.toISOString());
    expect(provider.extendTimeout).not.toHaveBeenCalled();
    expect(provider.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ ports: [3000] }),
      expect.anything(),
    );
    expect(provider.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "node", detached: true }),
    );
  });

  it.each(["listener", "HTTP"])(
    "keeps one startup past two minutes of %s readiness",
    async (phase) => {
      const { options, provider, command } = setup();
      const originalNow = Date.now();
      const clock = vi.spyOn(Date, "now");
      let delayed = false;
      if (phase === "listener") {
        provider.fs.readFile.mockImplementation((file) => {
          if (file.endsWith("listener-ready")) {
            if (!delayed) {
              delayed = true;
              clock.mockReturnValue(originalNow + 120_001);
              return "";
            }
            return "ready";
          }
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        });
      }
      const fetcher = vi.fn<typeof fetch>((input) => {
        const url = requestUrl(input);
        if (url.includes("/__autograph_preview_launch")) {
          return launchResponse();
        }
        if (phase === "HTTP" && !delayed) {
          delayed = true;
          clock.mockReturnValue(originalNow + 120_001);
          return new Response(null, { status: 503 });
        }
        return new Response("<main>Ready</main>", { headers: { "content-type": "text/html" } });
      });
      try {
        const result = await preview({ ...options, fetch: fetcher });
        expect(result.receipt.status).toBe("ready");
        expect(provider.runCommand).toHaveBeenCalledOnce();
        expect(command.kill).not.toHaveBeenCalled();
        expect(delayed).toBe(true);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("continues the same supervisor after an individual provider probe times out", async () => {
    const { options, provider, command } = setup();
    let reads = 0;
    provider.fs.readFile.mockImplementation(async (file, readOptions) => {
      if (file.endsWith("listener-ready")) {
        reads += 1;
        if (reads === 1) {
          return await delay(100, "ready", { signal: readOptions?.signal });
        }
        return "ready";
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("/__autograph_preview_launch")) {
        return launchResponse();
      }
      return new Response("<main>Ready</main>", { headers: { "content-type": "text/html" } });
    });
    const result = await preview({ ...options, fetch: fetcher, probeTimeoutMs: 20 });
    expect(result.receipt.status).toBe("ready");
    expect(reads).toBe(2);
    expect(provider.runCommand).toHaveBeenCalledOnce();
    expect(command.kill).not.toHaveBeenCalled();
  });

  it("replaces a retained preview whose provider command no longer exists", async () => {
    const { options, provider } = setup();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("/__autograph_preview_launch")) {
        return launchResponse();
      }
      return new Response("<main>Ready</main>", { headers: { "content-type": "text/html" } });
    });
    const previous = await preview({ ...options, fetch: fetcher });
    const missingCommand = new APIError(new Response("", { status: 404 }), {
      message: "command not found or has exited",
    });
    provider.getCommand.mockRejectedValueOnce(missingCommand).mockRejectedValueOnce(missingCommand);

    const replacement = await preview({ ...options, fetch: fetcher, previous });
    expect(replacement.receipt.status).toBe("ready");
    expect(provider.runCommand).toHaveBeenCalledTimes(2);
  });

  it("reports a supervisor exit even when startup markers were never written", async () => {
    const { options, provider, command } = setup();
    provider.getCommand.mockResolvedValue({ ...command, exitCode: 137 });
    provider.fs.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(preview(options)).rejects.toThrow("supervisor exited with code 137");
    expect(provider.runCommand).toHaveBeenCalledOnce();
    expect(command.kill).toHaveBeenCalledOnce();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [] }, expect.anything());
  });

  it("ends startup and cleans up when the actual provider lease expires", async () => {
    const { options, provider, command } = setup();
    const now = Date.now();
    const expiresAt = now + 100;
    provider.expiresAt = new Date(expiresAt);
    const lease = new AbortController();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(lease.signal);
    const fetcher = vi.fn<typeof fetch>(() => {
      // A relative timer can fire just before the wall clock reaches expiry.
      clock.mockReturnValue(expiresAt - 1);
      lease.abort(new DOMException("Provider lease expired", "TimeoutError"));
      return new Response(null, { status: 503 });
    });
    try {
      await expect(preview({ ...options, fetch: fetcher })).rejects.toThrow(
        "stopped during application HTTP readiness",
      );
      expect(command.kill).toHaveBeenCalledOnce();
      expect(command.wait).toHaveBeenCalledOnce();
      // Setup closes ingress, then opens it; expiry adds no ingress mutation.
      expect(provider.update).toHaveBeenCalledTimes(2);
      expect(provider.update).toHaveBeenLastCalledWith({ ports: [3001] }, expect.anything());
    } finally {
      timer.mockRestore();
      clock.mockRestore();
    }
  });

  it("does not start a preview when the Sandbox has already expired", async () => {
    const { options, provider } = setup();
    provider.expiresAt = new Date(Date.now() - 1);

    await expect(preview(options)).rejects.toThrow(
      "The private Sandbox has no remaining lifetime for a working preview.",
    );
    expect(provider.update).not.toHaveBeenCalled();
    expect(provider.runCommand).not.toHaveBeenCalled();
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
    await preview({ ...options, fetch: fetcher });
    expect(fetcher.mock.calls[2][1]?.headers).toEqual({
      cookie: "__Host-autograph-preview=capability; app_session=nonce",
    });
  });

  it("does not publish a receipt for an inert or unavailable server and closes ingress even if kill fails", async () => {
    const { command, options, provider } = setup();
    command.kill.mockRejectedValueOnce(new Error("provider kill failed"));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      preview({
        ...options,
        fetch: fetcher,
        probeTimeoutMs: 100,
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow("cleanup was incomplete");
    expect(command.kill).toHaveBeenCalled();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [] }, expect.anything());
  });

  it("does no provider work for an already cancelled turn", async () => {
    const { options, provider } = setup();
    await expect(preview({ ...options, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(provider.update).not.toHaveBeenCalled();
    expect(provider.runCommand).not.toHaveBeenCalled();
  });

  it("stops polling immediately when cancelled instead of resuming the stopped sandbox", async () => {
    const { command, options, provider } = setup();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      preview({ ...options, fetch: fetcher, signal: controller.signal }),
    ).rejects.toThrow();
    // Only listener readiness ran; cancellation must not trigger a filesystem read.
    expect(provider.fs.readFile).toHaveBeenCalledTimes(1);
    expect(command.kill).toHaveBeenCalled();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [] }, expect.anything());
  });

  it("cleans up if writing runtime configuration fails before HTTP observation", async () => {
    const { command, options, provider } = setup();
    provider.fs.writeFile.mockRejectedValueOnce(new Error("filesystem unavailable"));
    await expect(preview(options)).rejects.toThrow("filesystem unavailable");
    expect(command.kill).not.toHaveBeenCalled();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [] }, expect.anything());
  });
});

describe("safe interrupted startup diagnostics", () => {
  it("identifies listener startup without exposing a gateway or starting HTTP checks", async () => {
    const { options, provider, command } = setup();
    provider.fs.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      preview({
        ...options,
        fetch: fetcher,
        probeTimeoutMs: 100,
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow(
      "stopped during listener startup. Last observation: Listener readiness marker absent",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(command.kill).toHaveBeenCalled();
  });

  it("reports application HTTP status without copying response bodies, cookies, or URLs", async () => {
    const { options } = setup();
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.includes("/__autograph_preview_launch")) {
        return launchResponse();
      }
      return new Response("secret-response-body", {
        headers: { location: "/private?token=secret-token", "set-cookie": "secret-cookie" },
        status: 503,
      });
    });
    let failure: unknown;
    try {
      await preview({
        ...options,
        fetch: fetcher,
        probeTimeoutMs: 100,
        signal: AbortSignal.timeout(100),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected a readiness Error");
    }
    const { message } = failure;
    expect(message).toContain("application HTTP readiness. Last observation: Application HTTP 503");
    expect(message).not.toMatch(/secret|https:|token|cookie|preview\.example/u);
  });

  it("reports a safe transport class instead of an error message containing credentials", async () => {
    const { options } = setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("https://preview.example/?token=secret Cookie: private"));
    await expect(
      preview({
        ...options,
        fetch: fetcher,
        probeTimeoutMs: 100,
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow(
      "application HTTP readiness. Last observation: Readiness transport TypeError.",
    );
  });
});

describe("preview command termination", () => {
  it("does not finish cleanup on signal acknowledgement before command termination", async () => {
    const exited = Promise.withResolvers<null>();
    const command = {
      exitCode: null,
      kill: vi.fn(async () => {}),
      wait: vi.fn(async () => await exited.promise),
    };
    let settled = false;
    const cleanup = stopWorkingPreviewCommand(command);
    const markSettled = async () => {
      await cleanup;
      settled = true;
    };
    void markSettled();
    await vi.waitFor(() => {
      expect(command.wait).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    exited.resolve(null);
    await cleanup;
    const killOptions = command.kill.mock.calls[0]?.[1];
    const waitOptions = command.wait.mock.calls[0]?.[0];
    expect(settled).toBe(true);
    expect(command.kill).toHaveBeenCalledWith("SIGTERM", expect.anything());
    expect(killOptions?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(killOptions?.abortSignal).toMatchObject({ aborted: false });
    expect(command.wait).toHaveBeenCalledWith(expect.anything());
    expect(waitOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(waitOptions?.signal).toMatchObject({ aborted: false });
  });

  it("reports unconfirmed termination and uses an independent live cleanup signal", async () => {
    const { command, options, provider } = setup();
    const cancellation = new AbortController();
    command.wait.mockRejectedValue(new Error("termination unconfirmed"));
    // Abort after the detached command has been obtained so cleanup owns it.
    provider.runCommand.mockImplementation(async () => {
      cancellation.abort();
      return await Promise.resolve(command);
    });
    await expect(preview({ ...options, signal: cancellation.signal })).rejects.toThrow(
      "cleanup was incomplete",
    );
    expect(command.wait).toHaveBeenCalledOnce();
  });
});

describe("startup ownership recovery", () => {
  it("does not launch or mutate ingress while a previous startup remains pending", async () => {
    const { options, provider, state } = setup();
    const response = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>(async () => await response.promise);
    const first = (async () => {
      try {
        return await preview({
          ...options,
          fetch: fetcher,
          probeTimeoutMs: 100,
          signal: AbortSignal.timeout(100),
        });
      } catch (error) {
        return error;
      }
    })();
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledOnce();
    });
    const mutations = provider.update.mock.calls.length;
    await expect(preview(options)).rejects.toThrow("still pending");
    expect(provider.update.mock.calls).toHaveLength(mutations);
    expect(provider.runCommand).toHaveBeenCalledOnce();
    response.resolve(new Response(null, { status: 503 }));
    expect(await first).toBeInstanceOf(Error);
    expect(state.ownership).toBeNull();
  });

  it("retains ownership when dispatch did not return a command handle", async () => {
    const { options, provider, state } = setup();
    provider.runCommand.mockRejectedValue(new Error("dispatch response lost"));
    await expect(preview(options)).rejects.toThrow("cleanup was incomplete");
    expect(state.ownership).toMatchObject({ status: "cleanup-required" });
    await expect(preview(options)).rejects.toThrow("still pending");
    expect(provider.runCommand).toHaveBeenCalledOnce();
  });

  it("cannot close replacement ingress when an old startup fails late", async () => {
    const { options, provider, command, state } = setup();
    const fetcher = vi.fn<typeof fetch>(() => {
      state.ownership = {
        attemptId: "replacement",
        providerSessionId: "provider-1",
        status: "starting",
      };
      return new Response(null, { status: 503 });
    });
    await expect(
      preview({
        ...options,
        fetch: fetcher,
        probeTimeoutMs: 100,
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow();
    expect(provider.update).toHaveBeenLastCalledWith({ ports: [3001] }, expect.anything());
    expect(state.ownership?.attemptId).toBe("replacement");
    expect(command.wait).toHaveBeenCalledOnce();
  });
});

it("bounds each provider readiness read while cancellation ends the startup", async () => {
  const { options, provider, command } = setup();
  provider.fs.readFile.mockImplementation(async (file, readOptions) => {
    if (file.endsWith("listener-ready")) {
      return await delay(60_000, "ready", { signal: readOptions?.signal });
    }
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  const started = Date.now();
  await expect(
    preview({ ...options, probeTimeoutMs: 100, signal: AbortSignal.timeout(100) }),
  ).rejects.toThrow("stopped during listener startup");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(command.wait).toHaveBeenCalledOnce();
}, 8000);

it("sanitizes startup error files and keeps the safe cause visible if cleanup fails", async () => {
  const { options, provider, command } = setup();
  provider.fs.readFile.mockImplementation(async (file) => {
    if (file.endsWith("listener-ready")) {
      return await Promise.resolve("ready");
    }
    return await Promise.resolve(
      JSON.stringify({
        stderr:
          "Error: API_KEY=private-value request https://preview.example/?token=private-token failed",
      }),
    );
  });
  command.wait.mockRejectedValue(new Error("termination not confirmed"));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  let observed: unknown;
  try {
    await preview({
      ...options,
      fetch: fetcher,
      probeTimeoutMs: 100,
      signal: AbortSignal.timeout(100),
    });
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(AggregateError);
  if (!(observed instanceof AggregateError)) {
    throw new Error("Expected an AggregateError");
  }
  const { message } = observed;
  expect(message).toContain("The application server failed to start");
  expect(message).toContain("Error:");
  expect(message).not.toMatch(/private-value|private-token|https:/u);
});
