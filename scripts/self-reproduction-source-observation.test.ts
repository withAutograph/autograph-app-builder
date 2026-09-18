/* oxlint-disable eslint/require-await -- Async fixture callbacks implement the real reader contract. */
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  readdir,
  lstat,
  readlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { observeSource } from "./self-reproduction-source-observation";

const fs = { lstat, readFile, readdir, readlink };

it("retains binary bytes and dotfiles, inventories exclusions and never follows links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "source-observation-"));
  try {
    await writeFile(path.join(root, ".config"), Buffer.from([0, 255, 1]));
    await mkdir(path.join(root, "node_modules"));
    await symlink("/outside/secret", path.join(root, "external"));
    const retained = new Map<string, Buffer>();
    const result = await observeSource(fs, root, async (name, bytes) => {
      retained.set(name, bytes);
    });
    expect(result.completeWithinDeclaredScope).toBe(true);
    expect(retained.get(".config")).toEqual(Buffer.from([0, 255, 1]));
    expect(result.first).toContainEqual(
      expect.objectContaining({ kind: "link", path: "external", target: "/outside/secret" }),
    );
    expect(result.first).toContainEqual(
      expect.objectContaining({ kind: "excluded", path: "node_modules" }),
    );
    expect(retained.size).toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
it("preserves partial evidence for unreadable or changing sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "source-observation-"));
  try {
    await writeFile(path.join(root, "file"), "before");
    const changed = await observeSource(fs, root, async () => {
      await writeFile(path.join(root, "file"), "after");
    });
    expect(changed.stable).toBe(false);
    expect(changed.completeWithinDeclaredScope).toBe(false);
    const unreadable = await observeSource(
      {
        ...fs,
        readFile: async () => {
          throw new Error("secret credential detail");
        },
      },
      root,
      async () => {},
    );
    expect(unreadable.completeWithinDeclaredScope).toBe(false);
    expect(JSON.stringify(unreadable)).not.toContain("secret credential");
    expect(unreadable.first).toContainEqual(
      expect.objectContaining({ kind: "unreadable", path: "file" }),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
