import { getVercelPreviewProvider, registerVercelPreviewProvider } from "./vercel-preview-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@vercel/sandbox";

const sdk = vi.hoisted(() => ({ get: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @vercel/sandbox dependency used by this test.
vi.mock("@vercel/sandbox", () => ({ Sandbox: sdk }));

const { Sandbox: RealSandbox } = await vi.importActual<{ Sandbox: typeof Sandbox }>(
  "@vercel/sandbox",
);
const sandboxFixture = (name: string, status: "running" | "stopped"): Sandbox =>
  new RealSandbox({
    routes: [],
    sandbox: {
      createdAt: 0,
      currentSessionId: "fixture-session",
      name,
      persistent: false,
      status,
      updatedAt: 0,
    },
    session: {
      createdAt: 0,
      cwd: "/workspace",
      id: "fixture-session",
      memory: 2048,
      region: "fixture",
      requestedAt: 0,
      status,
      timeout: 60_000,
      updatedAt: 0,
      vcpus: 2,
    },
  });

describe("authenticated preview provider mapping", () => {
  beforeEach(() => sdk.get.mockReset());
  it("returns the authenticated running provider without reacquiring credentials", async () => {
    const provider = sandboxFixture("owned", "running");
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
    const old = registerVercelPreviewProvider("replacement", sandboxFixture("old", "running"));
    const current = sandboxFixture("new", "running");
    const cleanup = registerVercelPreviewProvider("replacement", current);
    old.unregister();
    expect(await getVercelPreviewProvider("replacement")).toBe(current);
    cleanup.unregister();
  });
  it("observes before resuming and adopts an already running session without another resume", async () => {
    const provider = sandboxFixture("owned", "stopped");
    const cleanup = registerVercelPreviewProvider("stopped", provider);
    expect(await getVercelPreviewProvider("stopped", undefined, false)).toBe(provider);
    const { signal } = new AbortController();
    const resumed = sandboxFixture("owned", "running");
    sdk.get.mockResolvedValue(resumed);
    expect(await getVercelPreviewProvider("stopped", signal)).toBe(resumed);
    expect(sdk.get).toHaveBeenCalledWith({ name: "owned", resume: false, signal });
    expect(cleanup.current).toBe(resumed);
    expect(await getVercelPreviewProvider("stopped")).toBe(resumed);
    expect(sdk.get).toHaveBeenCalledOnce();
    cleanup.unregister();
    await expect(getVercelPreviewProvider("stopped")).rejects.toThrow("not connected");
  });
  it("does not replace a newer registration when an earlier resume finishes", async () => {
    const original = sandboxFixture("owned", "stopped");
    const old = registerVercelPreviewProvider("in-flight", original);
    const deferred = Promise.withResolvers<Sandbox>();
    sdk.get.mockReturnValue(deferred.promise);
    const resuming = getVercelPreviewProvider("in-flight");
    const replacement = sandboxFixture("owned", "running");
    const current = registerVercelPreviewProvider("in-flight", replacement);
    deferred.resolve(sandboxFixture("owned", "running"));
    await expect(resuming).rejects.toThrow("not connected");
    expect(() => old.current).toThrow("not connected");
    old.unregister();
    expect(await getVercelPreviewProvider("in-flight")).toBe(replacement);
    current.unregister();
  });
});
