import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("generic sandbox tool boundaries", () => {
  it.each(["agent", "bash", "read_file", "write_file"])(
    "keeps %s unavailable",
    async (tool) => {
      const source = await readFile(
        resolve(process.cwd(), `agent/tools/${tool}.ts`),
        "utf8",
      );

      expect(source).toContain('import { disableTool } from "eve/tools";');
      expect(source).toContain("export default disableTool();");
    },
  );

  it("routes existing application reads through the manifest-bound inspector", async () => {
    const source = await readFile(
      resolve(process.cwd(), "agent/tools/inspect_repository.ts"),
      "utf8",
    );

    expect(source).toContain("inspect_existing_app");
    expect(source).not.toContain("and read_file respectively");
  });
});
