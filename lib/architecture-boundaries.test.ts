import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.[jt]sx?$/u.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("library architecture boundaries", () => {
  it("keeps library modules independent of UI and agent entry points", async () => {
    const files = await sourceFiles("lib");
    const violations = (
      await Promise.all(
        files.map(async (file) => ({
          file,
          source: await readFile(file, "utf8"),
        })),
      )
    )
      .filter(({ source }) =>
        /from ["']@\/(app|components|agent)\//u.test(source),
      )
      .map(({ file }) => file);

    expect(violations).toEqual([]);
  });
});
