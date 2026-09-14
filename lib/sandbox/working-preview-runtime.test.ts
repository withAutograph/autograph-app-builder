import type { Sandbox } from "@vercel/sandbox";
import { describe, expect, it, vi } from "vitest";

import { startWorkingPreview } from "./working-preview-runtime";

const setup = () => {
  const events: string[] = [];
  const command = { cmdId: "command-1", kill: vi.fn(async () => {}) };
  const provider = {
    currentSession: () => ({ sessionId: "provider-1" }),
    domain: () => "https://preview.example",
    expiresAt: new Date(Date.now() + 30 * 60_000),
    extendTimeout: vi.fn(),
    fs: {
      mkdir: vi.fn(),
      readFile: vi.fn((file: string) => {
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
