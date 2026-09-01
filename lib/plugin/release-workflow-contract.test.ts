import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("release publication workflow", () => {
  it("verifies already-promoted bytes without rebuilding them", async () => {
    const workflow = await readFile(
      resolve(".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("Download already-promoted bytes");
    expect(workflow).toContain("promotion-receipt.json");
    expect(workflow).toContain("autograph-release-promotion-v2");
    expect(workflow).toContain(
      "--json isDraft,isPrerelease --jq '(.isDraft | not) and .isPrerelease'",
    );
    expect(workflow).toContain("gh release verify-asset");
    expect(workflow).not.toContain("mise run package:build-portable-release");
    expect(workflow).not.toContain("docker build");
    expect(workflow).not.toContain("vercel build");
    expect(workflow).not.toContain("actions/attest-build-provenance");
  });

  it("binds deployment and tool readbacks before recoverable package publication", async () => {
    const publish = await readFile(
      resolve("scripts/release-publish.mts"),
      "utf8",
    );
    expect(publish).toContain("deployment.id !== endpointDeployment.id");
    expect(publish).toContain("hostedClient.listTools()");
    expect(publish).toContain("exactGithubReleaseExists()");
    expect(publish).toMatch(/"release",\s*"download"/u);
    expect(publish).not.toMatch(/buildx[\s\S]{0,80}"build"/u);
    expect(publish).not.toContain('vercel, ["build"');
  });
});
