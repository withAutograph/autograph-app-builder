import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readDocumentation = (path: string) => readFile(resolve(path), "utf8");

describe("public plugin installation documentation", () => {
  it.each(["README.md", "docs/installing.md"])(
    "%s provides a complete verified Codex install path",
    async (path) => {
      const documentation = await readDocumentation(path);
      const requiredSteps = [
        "release_version=0.2.0",
        'gh release download "v$release_version"',
        "shasum -a 256 -c SHA256SUMS",
        'gh release verify "v$release_version"',
        'gh release verify-asset "v$release_version"',
        '"autograph-app-builder-codex-marketplace-$release_version.tar.gz"',
        'codex plugin marketplace add "$marketplace_dir"',
        "codex plugin add autograph-app-builder@autograph",
      ];

      let previous = -1;
      for (const step of requiredSteps) {
        const index = documentation.indexOf(step);
        expect(index, `${path} omitted ${step}`).toBeGreaterThan(previous);
        previous = index;
      }
    },
  );

  it("keeps pre-release availability explicit", async () => {
    const documentation = await readDocumentation("docs/installing.md");

    expect(documentation).toContain(
      "Once the pre-release `v0.2.0` GitHub release is published",
    );
    expect(documentation).toMatch(
      /These\s+commands fail closed until `v0\.2\.0` exists/u,
    );
  });
});
