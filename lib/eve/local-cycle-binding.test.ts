import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { readLocalEveCycleBinding, rotateLocalEveCycleBinding } from "./local-cycle-binding";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function privateRoot() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "autograph-eve-cycle-")));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

describe("local Eve cycle binding", () => {
  it("atomically rotates one owner-only opaque cycle generation", async () => {
    const root = await privateRoot();
    const cyclePath = path.join(root, "cycle");
    const first = await rotateLocalEveCycleBinding(cyclePath);
    const second = await rotateLocalEveCycleBinding(cyclePath);

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
    expect(readLocalEveCycleBinding(cyclePath)).toBe(second);
  });

  it("rejects permissive or malformed cycle files", async () => {
    const root = await privateRoot();
    const cyclePath = path.join(root, "cycle");
    await writeFile(cyclePath, "not-a-cycle\n", { mode: 0o600 });
    expect(() => readLocalEveCycleBinding(cyclePath)).toThrow("invalid");

    await writeFile(cyclePath, `${"a".repeat(64)}\n`, { mode: 0o644 });
    await chmod(cyclePath, 0o644);
    expect(() => readLocalEveCycleBinding(cyclePath)).toThrow("owner-only");
  });
});
