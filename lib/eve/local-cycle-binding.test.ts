import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  readLocalEveCycleBinding,
  rotateLocalEveCycleBinding,
} from "./local-cycle-binding";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function privateRoot() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "autograph-eve-cycle-")),
  );
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

describe("local Eve cycle binding", () => {
  it("atomically rotates one owner-only opaque cycle generation", async () => {
    const root = await privateRoot();
    const path = join(root, "cycle");
    const first = await rotateLocalEveCycleBinding(path);
    const second = await rotateLocalEveCycleBinding(path);

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
    expect(readLocalEveCycleBinding(path)).toBe(second);
  });

  it("rejects permissive or malformed cycle files", async () => {
    const root = await privateRoot();
    const path = join(root, "cycle");
    await writeFile(path, "not-a-cycle\n", { mode: 0o600 });
    expect(() => readLocalEveCycleBinding(path)).toThrow("invalid");

    await writeFile(path, `${"a".repeat(64)}\n`, { mode: 0o644 });
    await chmod(path, 0o644);
    expect(() => readLocalEveCycleBinding(path)).toThrow("owner-only");
  });
});
