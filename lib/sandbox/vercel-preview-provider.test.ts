import { Sandbox } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";
import { getVercelPreviewProvider, registerVercelPreviewProvider } from "./vercel-preview-provider";

const makeProvider = (name: string, status: "running" | "stopped"): Sandbox =>
  Object.assign(new Sandbox(), { name, status });

describe("authenticated preview provider mapping", () => {
  it("returns the authenticated running provider without reacquiring credentials", async () => {
    const provider = makeProvider("owned", "running");
    const registration = registerVercelPreviewProvider("lookup", provider);
    expect(await getVercelPreviewProvider("lookup", undefined, false)).toBe(provider);
    registration.unregister();
  });
  it("rejects an unregistered handle without contacting the provider", async () => {
    await expect(getVercelPreviewProvider("not-registered")).rejects.toThrow("not connected");
  });
  it("does not unregister a replacement when the old handle stops", async () => {
    const old = registerVercelPreviewProvider("replacement", makeProvider("old", "running"));
    const current = makeProvider("new", "running");
    const cleanup = registerVercelPreviewProvider("replacement", current);
    old.unregister();
    expect(await getVercelPreviewProvider("replacement")).toBe(current);
    cleanup.unregister();
  });
});
