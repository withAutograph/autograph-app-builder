import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  assertExternalReferenceRoot,
  snapshotReferenceSource,
} from "./self-reproduction-reference-runtime";

it("rejects an in-source runtime", () => {
  expect(() => assertExternalReferenceRoot("/tmp/source", "/tmp/source/runtime")).toThrow();
  expect(() => assertExternalReferenceRoot("/tmp/source", "/tmp/external")).not.toThrow();
});

it("copies live tracked changes without credentials or ignored runtime files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reference-snapshot-test-"));
  const fixture = `${root}-fixture`;
  try {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFile(path.join(root, "app.ts"), "original");
    execFileSync("git", ["add", "app.ts"], { cwd: root });
    await writeFile(path.join(root, "app.ts"), "live edit");
    await writeFile(path.join(root, ".env.local"), "synthetic-private-value");
    await snapshotReferenceSource(root, fixture);
    expect(await readFile(path.join(fixture, "app.ts"), "utf-8")).toBe("live edit");
    await expect(readFile(path.join(fixture, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(fixture, { force: true, recursive: true });
  }
});
