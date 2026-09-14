import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(filePath);
      }
      return entry.isFile() && /\.[jt]sx?$/u.test(entry.name) ? [filePath] : [];
    }),
  );
  return nested.flat();
}

describe("library architecture boundaries", () => {
  it("keeps library modules independent of UI and agent entry points", async () => {
    const files = await sourceFiles("lib");
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(file, "utf-8"),
      })),
    );
    const violations = sources
      .filter(({ source }) => /from ["']@\/(?<namespace>app|components|agent)\//u.test(source))
      .map(({ file }) => file);

    expect(violations).toEqual([]);
  });
});
