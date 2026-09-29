import { getVercelPreviewProvider, registerVercelPreviewProvider } from "./vercel-preview-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@vercel/sandbox";
const sdk = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sdk }));

describe("authenticated preview provider mapping", () => {
  beforeEach(() => sdk.get.mockReset());
  it("returns the authenticated running provider without reacquiring credentials", async () => {
    const provider = { name: "owned", status: "running" } as Sandbox;
    const unregister = registerVercelPreviewProvider("lookup", provider);
    expect(await getVercelPreviewProvider("lookup", undefined, false)).toBe(provider);
    expect(sdk.get).not.toHaveBeenCalled();
    unregister();
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
    old();
    expect(await getVercelPreviewProvider("replacement")).toBe(current);
    cleanup();
  });
  it("only resumes a stopped provider when requested", async () => {
    const provider = { name: "owned", status: "stopped" } as Sandbox;
    const cleanup = registerVercelPreviewProvider("stopped", provider);
    expect(await getVercelPreviewProvider("stopped", undefined, false)).toBe(provider);
    const { signal } = new AbortController();
    sdk.get.mockResolvedValue({ status: "running" });
    await getVercelPreviewProvider("stopped", signal);
    expect(sdk.get).toHaveBeenCalledWith({ name: "owned", resume: true, signal });
    cleanup();
  });
});
