import { getVercelPreviewProvider, registerVercelPreviewProvider } from "./vercel-preview-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@vercel/sandbox";

const sdk = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sdk }));

describe("authenticated preview provider mapping", () => {
  beforeEach(() => sdk.get.mockReset());
  it("returns the authenticated running provider without reacquiring credentials", async () => {
    const provider = { name: "owned", status: "running" } as Sandbox;
    const registration = registerVercelPreviewProvider("lookup", provider);
    expect(await getVercelPreviewProvider("lookup", undefined, false)).toBe(provider);
    expect(sdk.get).not.toHaveBeenCalled();
    registration.unregister();
  });
  it("rejects an unregistered handle without contacting the provider", async () => {
    await expect(getVercelPreviewProvider("not-registered")).rejects.toThrow("not connected");
    expect(sdk.get).not.toHaveBeenCalled();
  });
  it("does not unregister a replacement when the old handle stops", async () => {
    const old = registerVercelPreviewProvider("replacement", {
      name: "old",
      status: "running",
    } as Sandbox);
    const current = { name: "new", status: "running" } as Sandbox;
    const cleanup = registerVercelPreviewProvider("replacement", current);
    old.unregister();
    expect(await getVercelPreviewProvider("replacement")).toBe(current);
    cleanup.unregister();
  });
  it("only resumes a stopped provider when requested", async () => {
    const provider = { name: "owned", status: "stopped" } as Sandbox;
    const cleanup = registerVercelPreviewProvider("stopped", provider);
    expect(await getVercelPreviewProvider("stopped", undefined, false)).toBe(provider);
    const { signal } = new AbortController();
    const resumed = { name: "owned", status: "running" } as Sandbox;
    sdk.get.mockResolvedValue(resumed);
    expect(await getVercelPreviewProvider("stopped", signal)).toBe(resumed);
    expect(sdk.get).toHaveBeenCalledWith({ name: "owned", resume: true, signal });
    expect(cleanup.current).toBe(resumed);
    expect(await getVercelPreviewProvider("stopped")).toBe(resumed);
    expect(sdk.get).toHaveBeenCalledOnce();
    cleanup.unregister();
    await expect(getVercelPreviewProvider("stopped")).rejects.toThrow("not connected");
  });
  it("does not replace a newer registration when an earlier resume finishes", async () => {
    const original = { name: "owned", status: "stopped" } as Sandbox;
    const old = registerVercelPreviewProvider("in-flight", original);
    const deferred = Promise.withResolvers<Sandbox>();
    sdk.get.mockReturnValue(deferred.promise);
    const resuming = getVercelPreviewProvider("in-flight");
    const replacement = { name: "owned", status: "running" } as Sandbox;
    const current = registerVercelPreviewProvider("in-flight", replacement);
    deferred.resolve({ name: "owned", status: "running" } as Sandbox);
    await expect(resuming).rejects.toThrow("not connected");
    expect(() => old.current).toThrow("not connected");
    old.unregister();
    expect(await getVercelPreviewProvider("in-flight")).toBe(replacement);
    current.unregister();
  });
});
