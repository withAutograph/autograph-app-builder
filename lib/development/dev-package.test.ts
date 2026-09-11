import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "../../scripts/portable-release";
import {
  createDevelopmentPackage,
  developmentLaunchEnvironment,
  registerDevelopmentPackage,
} from "./dev-package";

describe("development Codex package", () => {
  it("creates a stable loopback-only marketplace with exactly five public tools and no app surface", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "autograph-dev-package-"))
    );
    try {
      const result = await createDevelopmentPackage({
        outputRoot: root,
        port: 3210,
        repositoryRoot: resolve("."),
      });
      const marketplace = JSON.parse(
        await readFile(
          join(result.marketplaceRoot, ".agents/plugins/marketplace.json"),
          "utf-8"
        )
      );
      const manifest = JSON.parse(
        await readFile(
          join(result.pluginRoot, ".codex-plugin/plugin.json"),
          "utf-8"
        )
      );
      const mcp = JSON.parse(
        await readFile(join(result.pluginRoot, ".mcp.json"), "utf-8")
      );
      const tools = JSON.parse(
        await readFile(join(result.pluginRoot, "tools-list.json"), "utf-8")
      );
      expect(result.marketplaceRoot).toBe(join(root, "marketplace"));
      expect(marketplace).toMatchObject({
        name: "autograph-dev",
        plugins: [
          {
            name: "app-builder",
            source: {
              path: "./plugins/app-builder",
              source: "local",
            },
          },
        ],
      });
      expect(manifest.name).toBe("app-builder");
      expect(manifest.version).toBe("0.0.0-development.3210");
      expect(manifest.interface).toMatchObject({
        displayName: "Autograph App Builder (Development)",
        shortDescription: "Build with local App Builder and Arrusted changes",
      });
      expect(manifest).not.toHaveProperty("apps");
      expect(mcp).toEqual({
        mcpServers: {
          "app-builder-dev-3210": {
            oauth_resource: "http://127.0.0.1:3210/mcp",
            type: "http",
            url: "http://127.0.0.1:3210/mcp",
          },
        },
      });
      expect(tools).toEqual([...TOOL_NAMES]);
      expect(result.receipt).toMatchObject({
        format: "autograph-development-package-v2",
        mcpAppPreview: false,
        publication: false,
        selector: "app-builder@autograph-dev",
        version: "0.0.0-development.3210",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("installs development guidance without enabling it globally", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-scope-"));
    const commands: {
      args: readonly string[];
      allowFailure: boolean;
    }[] = [];
    try {
      await registerDevelopmentPackage({
        codexBin: "/mise/bin/codex",
        codexHome,
        marketplaceRoot: "/private/dev/marketplace",
        runner: async (args, options) => {
          commands.push({ args, allowFailure: options.allowFailure ?? false });
          if (args[0] === "plugin" && args[1] === "add") {
            await writeFile(
              join(codexHome, "config.toml"),
              'model = "gpt-6-astra"\n[plugins."app-builder@autograph-dev"]\nenabled = true\n[plugins."app-builder@autograph"]\nenabled = true\n'
            );
          }
          if (args.includes("list")) {
            expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
              'model = "gpt-6-astra"\n[plugins."app-builder@autograph-dev"]\nenabled = false\n[plugins."app-builder@autograph"]\nenabled = true\n'
            );
          }
          return {
            stdout: args.includes("list")
              ? JSON.stringify({
                  installed: [
                    {
                      pluginId: "app-builder@autograph-dev",
                      name: "app-builder",
                      marketplaceName: "autograph-dev",
                      version: "0.0.0-development.3210",
                      installed: true,
                      enabled: false,
                      source: {
                        source: "local",
                        path: "/private/dev/marketplace/plugins/app-builder",
                      },
                      marketplaceSource: {
                        sourceType: "local",
                        source: "/private/dev/marketplace",
                      },
                    },
                  ],
                })
              : "{}",
            stderr: "",
          };
        },
        version: "0.0.0-development.3210",
      });
      expect(commands).toEqual([
        {
          allowFailure: true,
          args: ["plugin", "remove", "app-builder@autograph-dev", "--json"],
        },
        {
          allowFailure: true,
          args: ["plugin", "marketplace", "remove", "autograph-dev", "--json"],
        },
        {
          allowFailure: false,
          args: [
            "plugin",
            "marketplace",
            "add",
            "/private/dev/marketplace",
            "--json",
          ],
        },
        {
          allowFailure: false,
          args: ["plugin", "add", "app-builder@autograph-dev", "--json"],
        },
        {
          allowFailure: false,
          args: ["plugin", "list", "--marketplace", "autograph-dev", "--json"],
        },
      ]);
    } finally {
      await rm(codexHome, { force: true, recursive: true });
    }
  });

  it("closes every publication, hosted, provider, and release capability", () => {
    expect(
      developmentLaunchEnvironment({
        dependencyKey: "a".repeat(64),
        destinationRoot: "/private/dev/destination",
        evePort: 2000,
        fingerprint: "f".repeat(64),
        snapshotRoot: "/private/dev/source",
        sourceRoot: "/private/user/arrusted",
        sourceSha: "b".repeat(40),
        sourceTree: "c".repeat(40),
      })
    ).toMatchObject({
      APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
      APP_BUILDER_DEVELOPMENT_SNAPSHOT_ROOT: "/private/dev/source",
      APP_BUILDER_DEVELOPMENT_SOURCE_ROOT: "/private/user/arrusted",
      APP_BUILDER_DEVELOPMENT_SOURCE_SHA: "b".repeat(40),
      APP_BUILDER_DEVELOPMENT_SOURCE_TREE: "c".repeat(40),
      APP_BUILDER_EXECUTION_BUNDLE: "local-development",
      APP_BUILDER_EXECUTION_MODE: "development",
      APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
      APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
      APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
      APP_BUILDER_LOCAL_PUBLICATION: "0",
      APP_BUILDER_SANDBOX_PROVIDER: "vercel",
      EVE_HOSTED_ADAPTER: "0",
      REPOSITORY_LOCAL_ROOTS: "/private/dev/source",
      REPOSITORY_WORKSPACE_ROOT: "/private/dev/destination",
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "360000",
      WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: "360000",
      WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
    });
    expect(
      developmentLaunchEnvironment({
        dependencyKey: "a".repeat(64),
        destinationRoot: "/private/dev/destination",
        evePort: 2000,
        fingerprint: "f".repeat(64),
        snapshotRoot: "/private/dev/source",
        sourceRoot: "/private/user/arrusted",
        sourceSha: "b".repeat(40),
        sourceTree: "c".repeat(40),
      })
    ).not.toHaveProperty("APP_BUILDER_SANDBOX_IMAGE");
  });
});
