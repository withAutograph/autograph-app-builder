import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  registeredAutographToolNames,
  sha256,
} from "../../scripts/portable-release";

export const DEVELOPMENT_PLUGIN_NAME = "app-builder@autograph-dev";

export async function createDevelopmentPackage(input: {
  repositoryRoot: string;
  outputRoot: string;
  port: number;
}) {
  const repositoryRoot = resolve(input.repositoryRoot);
  const pluginRoot = join(resolve(input.outputRoot), DEVELOPMENT_PLUGIN_NAME);
  const endpoint = `http://127.0.0.1:${input.port}/mcp`;
  await mkdir(join(pluginRoot, ".codex-plugin"), {
    recursive: true,
    mode: 0o700,
  });
  await cp(join(repositoryRoot, "skills"), join(pluginRoot, "skills"), {
    recursive: true,
  });
  await mkdir(join(pluginRoot, "assets"), { mode: 0o700 });
  await cp(
    join(repositoryRoot, "assets/autograph-icon.png"),
    join(pluginRoot, "assets/autograph-icon.png"),
  );
  const sourceManifest = JSON.parse(
    await readFile(join(repositoryRoot, ".codex-plugin/plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  const manifest = {
    ...sourceManifest,
    name: DEVELOPMENT_PLUGIN_NAME,
    version: "0.0.0-development",
    description: "Local-only Autograph App Builder development package.",
    mcpServers: "./.mcp.json",
  };
  delete (manifest as { apps?: unknown }).apps;
  const mcp = {
    mcpServers: {
      [DEVELOPMENT_PLUGIN_NAME]: { type: "http", url: endpoint },
    },
  };
  const handler = await readFile(
    join(repositoryRoot, "lib/mcp/request-handler.ts"),
    "utf8",
  );
  const tools = [...registeredAutographToolNames(handler)];
  await Promise.all([
    writeFile(
      join(pluginRoot, ".codex-plugin/plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(pluginRoot, ".mcp.json"),
      `${JSON.stringify(mcp, null, 2)}\n`,
      {
        mode: 0o600,
      },
    ),
    writeFile(
      join(pluginRoot, "tools-list.json"),
      `${JSON.stringify(tools, null, 2)}\n`,
      {
        mode: 0o600,
      },
    ),
  ]);
  const receipt = {
    format: "autograph-development-package-v1",
    name: DEVELOPMENT_PLUGIN_NAME,
    endpoint,
    tools,
    mcpAppPreview: false,
    publication: false,
    digest: sha256(
      JSON.stringify({ name: DEVELOPMENT_PLUGIN_NAME, endpoint, tools }),
    ),
  } as const;
  await writeFile(
    join(pluginRoot, "development-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { pluginRoot, receipt };
}

export function developmentLaunchEnvironment(input: {
  snapshotRoot: string;
  destinationRoot: string;
  image: string;
  fingerprint: string;
  dependencyKey: string;
  evePort: number;
}): Readonly<Record<string, string>> {
  return {
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: input.fingerprint,
    APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY: input.dependencyKey,
    APP_BUILDER_SANDBOX_IMAGE: input.image,
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_PUBLICATION: "0",
    APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
    APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
    APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
    APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
    APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
    EVE_HOSTED_ADAPTER: "0",
    EVE_AGENT_HOST: `http://127.0.0.1:${input.evePort}`,
    REPOSITORY_LOCAL_ROOTS: input.snapshotRoot,
    REPOSITORY_WORKSPACE_ROOT: input.destinationRoot,
  };
}
