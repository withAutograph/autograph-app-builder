import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDevelopmentPackage,
  developmentLaunchEnvironment,
} from "./dev-package";
import { TOOL_NAMES } from "../../scripts/portable-release";

describe("development Codex package", () => {
  it("creates an ignored loopback-only package with exactly five public tools and no app surface", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "autograph-dev-package-")),
    );
    try {
      const result = await createDevelopmentPackage({
        repositoryRoot: resolve("."),
        outputRoot: root,
        port: 3210,
      });
      const manifest = JSON.parse(
        await readFile(
          join(result.pluginRoot, ".codex-plugin/plugin.json"),
          "utf8",
        ),
      );
      const mcp = JSON.parse(
        await readFile(join(result.pluginRoot, ".mcp.json"), "utf8"),
      );
      const tools = JSON.parse(
        await readFile(join(result.pluginRoot, "tools-list.json"), "utf8"),
      );
      expect(manifest.name).toBe("app-builder@autograph-dev");
      expect(manifest).not.toHaveProperty("apps");
      expect(mcp).toEqual({
        mcpServers: {
          "app-builder@autograph-dev": {
            type: "http",
            url: "http://127.0.0.1:3210/mcp",
          },
        },
      });
      expect(tools).toEqual([...TOOL_NAMES]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes every publication, hosted, provider, and release capability", () => {
    expect(
      developmentLaunchEnvironment({
        snapshotRoot: "/private/dev/source",
        destinationRoot: "/private/dev/destination",
        image: `app-builder-autograph-dev:${"a".repeat(64)}-linux-arm64`,
        fingerprint: "f".repeat(64),
        dependencyKey: "a".repeat(64),
        evePort: 2000,
      }),
    ).toMatchObject({
      APP_BUILDER_EXECUTION_MODE: "development",
      APP_BUILDER_LOCAL_PUBLICATION: "0",
      APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
      APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
      APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
      EVE_HOSTED_ADAPTER: "0",
      APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
      REPOSITORY_LOCAL_ROOTS: "/private/dev/source",
      REPOSITORY_WORKSPACE_ROOT: "/private/dev/destination",
    });
  });
});
