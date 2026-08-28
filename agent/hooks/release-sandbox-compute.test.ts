import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Eve durable turn execution envelope", () => {
  it("acquires before dynamic tools at turn.started and releases only at terminal boundaries", async () => {
    const [hook, sandbox] = await Promise.all([
      readFile("agent/hooks/release-sandbox-compute.ts", "utf8"),
      readFile("agent/sandbox.ts", "utf8"),
    ]);
    expect(hook).toContain('"turn.started"');
    expect(hook).toContain("acquireHostedSandboxExecutionLease");
    expect(hook).toContain('"turn.completed"');
    expect(hook).toContain('"turn.cancelled"');
    expect(hook).toContain('"turn.failed"');
    expect(hook).not.toContain('"session.waiting"');
    expect(sandbox).not.toContain("acquireHostedSandboxExecutionLease");
  });
});
