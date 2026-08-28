import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("pre-release publication workflow", () => {
  it("publishes v0.2.1 as a prerelease without marking it latest", async () => {
    const workflow = await readFile(
      resolve(".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toMatch(
      /gh release create "\$GITHUB_REF_NAME"[\s\S]*?--draft \\\n\s+--prerelease \\/u,
    );
    expect(workflow).toContain(
      'gh release edit "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --draft=false --prerelease --latest=false',
    );
    expect(workflow.match(/--prerelease/gu)).toHaveLength(2);
    expect(workflow).not.toMatch(/--latest(?:\s|$)/u);
    expect(workflow).toContain(
      "--json isDraft,isPrerelease --jq '.isDraft and .isPrerelease'",
    );
    expect(workflow).toContain(
      "--json isDraft,isPrerelease --jq '(.isDraft | not) and .isPrerelease'",
    );
  });
});
