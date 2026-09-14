import { getVercelPreviewProvider, withVercelPreviewProvider } from "./vercel-preview-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxBackend } from "eve/sandbox";

const sdk = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sdk }));

const register = async (id: string) => {
  const captureState = vi
    .fn()
    .mockResolvedValue({ metadata: { sandboxName: "backend-owned-name" } });
  const stop = vi.fn(() => Promise.resolve());
  const shutdown = vi.fn(() => Promise.resolve());
  const backend = {
    create: vi.fn().mockResolvedValue({ captureState, session: { id }, shutdown, stop }),
  };
  const wrapped = withVercelPreviewProvider(backend as unknown as SandboxBackend<unknown, unknown>);
  const handle = await wrapped.create({} as Parameters<typeof wrapped.create>[0]);
  return { captureState, handle, shutdown, stop };
};

describe("authenticated preview provider mapping", () => {
  beforeEach(() => sdk.get.mockReset());
  it("uses backend-captured provider name and explicit resume choice", async () => {
    const { handle, captureState } = await register("lookup");
    const { signal } = new AbortController();
    sdk.get.mockResolvedValue({ status: "running" });
    await getVercelPreviewProvider("lookup", signal, false);
    expect(captureState).toHaveBeenCalledOnce();
    expect(sdk.get).toHaveBeenCalledWith({ name: "backend-owned-name", resume: false, signal });
    await handle.stop();
  });
  it("rejects an unregistered handle without contacting the provider", async () => {
    await expect(getVercelPreviewProvider("not-registered")).rejects.toThrow("not connected");
    expect(sdk.get).not.toHaveBeenCalled();
  });
  it.each(["stop", "shutdown"] as const)(
    "removes mapping on %s even if cleanup fails",
    async (operation) => {
      const registered = await register(operation);
      registered[operation].mockRejectedValue(new Error("cleanup failed"));
      await expect(registered.handle[operation]()).rejects.toThrow("cleanup failed");
      await expect(getVercelPreviewProvider(operation)).rejects.toThrow("not connected");
      expect(sdk.get).not.toHaveBeenCalled();
    },
  );
  it("does not unregister a replacement when the old handle stops", async () => {
    const old = await register("replacement");
    const current = await register("replacement");
    await old.handle.stop();
    await getVercelPreviewProvider("replacement", undefined, true);
    expect(current.captureState).toHaveBeenCalledOnce();
    expect(sdk.get).toHaveBeenCalledWith({
      name: "backend-owned-name",
      resume: true,
      signal: undefined,
    });
    await current.handle.shutdown();
  });
});
