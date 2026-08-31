import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  registeredAutographToolNames,
  sha256,
} from "../../scripts/portable-release";

const execFileAsync = promisify(execFile);

export const DEVELOPMENT_MARKETPLACE_NAME = "autograph-dev";
export const DEVELOPMENT_PLUGIN_NAME = "app-builder";
export const DEVELOPMENT_PLUGIN_SELECTOR = `${DEVELOPMENT_PLUGIN_NAME}@${DEVELOPMENT_MARKETPLACE_NAME}`;
export const DEVELOPMENT_MCP_SERVER_NAME = "app-builder-dev";
export const DEVELOPMENT_VERSION = "0.0.0-development";

export type DevelopmentCodexCommandRunner = (
  args: readonly string[],
  options: { allowFailure?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export async function createDevelopmentPackage(input: {
  repositoryRoot: string;
  outputRoot: string;
  port: number;
}) {
  const repositoryRoot = resolve(input.repositoryRoot);
  const outputRoot = resolve(input.outputRoot);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const temporaryMarketplaceRoot = await mkdtemp(
    join(outputRoot, ".marketplace-"),
  );
  const marketplaceRoot = join(outputRoot, "marketplace");
  const pluginRoot = join(
    temporaryMarketplaceRoot,
    "plugins",
    DEVELOPMENT_PLUGIN_NAME,
  );
  const endpoint = `http://127.0.0.1:${input.port}/mcp`;
  try {
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
    const sourceInterface =
      typeof sourceManifest.interface === "object" &&
      sourceManifest.interface !== null
        ? (sourceManifest.interface as Record<string, unknown>)
        : {};
    const manifest = {
      ...sourceManifest,
      name: DEVELOPMENT_PLUGIN_NAME,
      version: DEVELOPMENT_VERSION,
      description: "Local-only Autograph App Builder development package.",
      interface: {
        ...sourceInterface,
        displayName: "Autograph App Builder (Development)",
        shortDescription: "Build with local App Builder and Arrusted changes",
      },
      mcpServers: "./.mcp.json",
    };
    delete (manifest as { apps?: unknown }).apps;
    const mcp = {
      mcpServers: {
        [DEVELOPMENT_MCP_SERVER_NAME]: { type: "http", url: endpoint },
      },
    };
    const handler = await readFile(
      join(repositoryRoot, "lib/mcp/request-handler.ts"),
      "utf8",
    );
    const tools = [...registeredAutographToolNames(handler)];
    const marketplaceManifestPath = join(
      temporaryMarketplaceRoot,
      ".agents/plugins/marketplace.json",
    );
    await mkdir(dirname(marketplaceManifestPath), {
      recursive: true,
      mode: 0o700,
    });
    const marketplace = {
      name: DEVELOPMENT_MARKETPLACE_NAME,
      interface: { displayName: "Autograph Development" },
      plugins: [
        {
          name: DEVELOPMENT_PLUGIN_NAME,
          source: {
            source: "local",
            path: `./plugins/${DEVELOPMENT_PLUGIN_NAME}`,
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Developer Tools",
        },
      ],
    };
    await Promise.all([
      writeFile(
        marketplaceManifestPath,
        `${JSON.stringify(marketplace, null, 2)}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        join(pluginRoot, ".codex-plugin/plugin.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(mcp, null, 2)}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        join(pluginRoot, "tools-list.json"),
        `${JSON.stringify(tools, null, 2)}\n`,
        { mode: 0o600 },
      ),
    ]);
    const receipt = {
      format: "autograph-development-package-v2",
      marketplace: DEVELOPMENT_MARKETPLACE_NAME,
      plugin: DEVELOPMENT_PLUGIN_NAME,
      selector: DEVELOPMENT_PLUGIN_SELECTOR,
      mcpServer: DEVELOPMENT_MCP_SERVER_NAME,
      endpoint,
      tools,
      mcpAppPreview: false,
      publication: false,
      digest: sha256(
        JSON.stringify({
          marketplace: DEVELOPMENT_MARKETPLACE_NAME,
          plugin: DEVELOPMENT_PLUGIN_NAME,
          selector: DEVELOPMENT_PLUGIN_SELECTOR,
          mcpServer: DEVELOPMENT_MCP_SERVER_NAME,
          endpoint,
          tools,
        }),
      ),
    } as const;
    await writeFile(
      join(pluginRoot, "development-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rm(marketplaceRoot, { recursive: true, force: true });
    await rename(temporaryMarketplaceRoot, marketplaceRoot);
    return {
      marketplaceRoot,
      pluginRoot: join(marketplaceRoot, "plugins", DEVELOPMENT_PLUGIN_NAME),
      receipt,
    };
  } finally {
    await rm(temporaryMarketplaceRoot, { recursive: true, force: true });
  }
}

export async function registerDevelopmentPackage(input: {
  codexBin: string;
  codexHome: string;
  marketplaceRoot: string;
  runner?: DevelopmentCodexCommandRunner;
}) {
  const codexBin = resolve(input.codexBin);
  const codexHome = resolve(input.codexHome);
  const marketplaceRoot = resolve(input.marketplaceRoot);
  const runner: DevelopmentCodexCommandRunner =
    input.runner ??
    (async (args, options) => {
      try {
        const result = await execFileAsync(codexBin, [...args], {
          env: { ...process.env, CODEX_HOME: codexHome },
        });
        return { stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        if (options.allowFailure) {
          const failed = error as { stdout?: string; stderr?: string };
          return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
        }
        throw error;
      }
    });
  await runner(["plugin", "remove", DEVELOPMENT_PLUGIN_SELECTOR, "--json"], {
    allowFailure: true,
  });
  await runner(
    ["plugin", "marketplace", "remove", DEVELOPMENT_MARKETPLACE_NAME, "--json"],
    { allowFailure: true },
  );
  await runner(["plugin", "marketplace", "add", marketplaceRoot, "--json"], {});
  await runner(["plugin", "add", DEVELOPMENT_PLUGIN_SELECTOR, "--json"], {});
  const listed = await runner(
    ["plugin", "list", "--marketplace", DEVELOPMENT_MARKETPLACE_NAME, "--json"],
    {},
  );
  const parsed = JSON.parse(listed.stdout) as { installed?: unknown[] };
  const installed = parsed.installed?.[0] as
    | {
        pluginId?: unknown;
        name?: unknown;
        marketplaceName?: unknown;
        version?: unknown;
        installed?: unknown;
        enabled?: unknown;
        source?: { source?: unknown; path?: unknown };
        marketplaceSource?: { sourceType?: unknown; source?: unknown };
      }
    | undefined;
  if (
    !Array.isArray(parsed.installed) ||
    parsed.installed.length !== 1 ||
    installed?.pluginId !== DEVELOPMENT_PLUGIN_SELECTOR ||
    installed.name !== DEVELOPMENT_PLUGIN_NAME ||
    installed.marketplaceName !== DEVELOPMENT_MARKETPLACE_NAME ||
    installed.version !== DEVELOPMENT_VERSION ||
    installed.installed !== true ||
    installed.enabled !== true ||
    installed.source?.source !== "local" ||
    installed.source.path !==
      join(marketplaceRoot, "plugins", DEVELOPMENT_PLUGIN_NAME) ||
    installed.marketplaceSource?.sourceType !== "local" ||
    installed.marketplaceSource.source !== marketplaceRoot
  )
    throw new Error(
      `Codex did not report the exact enabled ${DEVELOPMENT_PLUGIN_SELECTOR} installation.`,
    );
  return { selector: DEVELOPMENT_PLUGIN_SELECTOR, marketplaceRoot };
}

export function developmentLaunchEnvironment(input: {
  snapshotRoot: string;
  destinationRoot: string;
  sourceSha: string;
  sourceTree: string;
  fingerprint: string;
  dependencyKey: string;
  evePort: number;
}): Readonly<Record<string, string>> {
  return {
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    APP_BUILDER_DEVELOPMENT_SOURCE_SHA: input.sourceSha,
    APP_BUILDER_DEVELOPMENT_SOURCE_TREE: input.sourceTree,
    APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: input.fingerprint,
    APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY: input.dependencyKey,
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_PUBLICATION: "0",
    APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
    APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
    APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
    APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
    APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
    EVE_HOSTED_ADAPTER: "0",
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
    EVE_AGENT_HOST: `http://127.0.0.1:${input.evePort}`,
    REPOSITORY_LOCAL_ROOTS: input.snapshotRoot,
    REPOSITORY_WORKSPACE_ROOT: input.destinationRoot,
  };
}
