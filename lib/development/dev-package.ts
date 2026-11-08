import { developmentExecutionEnvironment } from "./execution-environment.mjs";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { registeredAutographToolNames, sha256 } from "../../scripts/portable-release";

const PLUGIN_ICON_PATH = "assets/autograph-icon.png";
const PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json";

const execFileAsync = promisify(execFile);

export const DEVELOPMENT_MARKETPLACE_NAME = "autograph-dev";
export const DEVELOPMENT_PLUGIN_NAME = "app-builder";
export const DEVELOPMENT_PLUGIN_SELECTOR = `${DEVELOPMENT_PLUGIN_NAME}@${DEVELOPMENT_MARKETPLACE_NAME}`;
export const DEVELOPMENT_MCP_SERVER_NAME = "app-builder-dev";
export const DEVELOPMENT_VERSION = "0.0.0-development";

const developmentVersion = (port: number, hosted = false) =>
  `${DEVELOPMENT_VERSION}.${port}${hosted ? ".hosted" : ""}`;

export interface HostedSessionConnection {
  resourceUrl: string;
  codexBin: string;
  nodeBin: string;
  cwd: string;
}

export type DevelopmentCodexCommandRunner = (
  args: readonly string[],
  options: { allowFailure?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

const packageInputDigest = async (directoryPath: string): Promise<string> => {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const contents = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          return [entry.name, await packageInputDigest(entryPath)] as const;
        }
        if (!entry.isFile()) {
          throw new Error(`Development package input was not a regular file: ${entryPath}`);
        }
        return [entry.name, sha256(await readFile(entryPath))] as const;
      }),
  );
  return sha256(JSON.stringify(contents));
};

/**
 * Only bytes that are installed into Codex or define its MCP registration
 * require a package rebuild.  Keeping this separate from the App Builder
 * runtime lets UI-only changes retain the existing local installation.
 */
export const developmentPackageFingerprint = async (input: {
  repositoryRoot: string;
  port: number;
  origin?: string;
  hostedSession?: HostedSessionConnection;
}) => {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  return sha256(
    JSON.stringify({
      icon: sha256(await readFile(path.join(repositoryRoot, PLUGIN_ICON_PATH))),
      mcpHandler: sha256(await readFile(path.join(repositoryRoot, "lib/mcp/request-handler.ts"))),
      origin: input.origin,
      hostedSession: input.hostedSession,
      plugin: sha256(await readFile(path.join(repositoryRoot, PLUGIN_MANIFEST_PATH))),
      port: input.port,
      skills: await packageInputDigest(path.join(repositoryRoot, "skills")),
    }),
  );
};

export const createDevelopmentPackage = async (input: {
  repositoryRoot: string;
  outputRoot: string;
  port: number;
  origin?: string;
  hostedSession?: HostedSessionConnection;
}) => {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const outputRoot = path.resolve(input.outputRoot);
  await mkdir(outputRoot, { mode: 0o700, recursive: true });
  const temporaryMarketplaceRoot = await mkdtemp(path.join(outputRoot, ".marketplace-"));
  const marketplaceRoot = path.join(outputRoot, "marketplace");
  const pluginRoot = path.join(temporaryMarketplaceRoot, "plugins", DEVELOPMENT_PLUGIN_NAME);
  const origin = input.origin ?? `http://127.0.0.1:${input.port}`;
  const endpoint = `${origin}/mcp`;
  // Codex retains an MCP transport by server name across tasks.  Make the
  // local-only transport identity include its loopback port so a fresh
  // development task cannot inherit a connection to an earlier dev server.
  const mcpServer = `${DEVELOPMENT_MCP_SERVER_NAME}-${input.port}${input.origin === undefined ? "" : "-https"}${input.hostedSession === undefined ? "" : "-hosted"}`;
  const version = developmentVersion(input.port, input.hostedSession !== undefined);
  try {
    await mkdir(path.join(pluginRoot, ".codex-plugin"), {
      mode: 0o700,
      recursive: true,
    });
    await cp(path.join(repositoryRoot, "skills"), path.join(pluginRoot, "skills"), {
      recursive: true,
    });
    await mkdir(path.join(pluginRoot, "assets"), { mode: 0o700 });
    await cp(path.join(repositoryRoot, PLUGIN_ICON_PATH), path.join(pluginRoot, PLUGIN_ICON_PATH));
    const sourceManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, PLUGIN_MANIFEST_PATH), "utf-8"),
    ) as Record<string, unknown>;
    const sourceInterface =
      typeof sourceManifest.interface === "object" && sourceManifest.interface !== null
        ? (sourceManifest.interface as Record<string, unknown>)
        : {};
    const manifest = {
      ...sourceManifest,
      description: "Local-only Autograph App Builder development package.",
      interface: {
        ...sourceInterface,
        displayName:
          input.hostedSession === undefined
            ? "Autograph App Builder (Development)"
            : "Autograph App Builder (Existing session)",
        shortDescription:
          input.hostedSession === undefined
            ? "Build with local App Builder and Arrusted changes"
            : "Access existing hosted sessions through the local native connector",
      },
      mcpServers: "./.mcp.json",
      name: DEVELOPMENT_PLUGIN_NAME,
      version,
    };
    delete (manifest as { apps?: unknown }).apps;
    const mcp = {
      mcpServers: {
        [mcpServer]:
          input.hostedSession === undefined
            ? {
                oauth_resource: endpoint,
                type: "http",
                url: endpoint,
              }
            : {
                type: "stdio",
                command: input.hostedSession.nodeBin,
                args: [
                  "--import",
                  fileURLToPath(import.meta.resolve("tsx")),
                  path.join(repositoryRoot, "scripts/local-hosted-session-connector.mts"),
                  "--codex-bin",
                  input.hostedSession.codexBin,
                  "--resource-url",
                  input.hostedSession.resourceUrl,
                  "--cwd",
                  input.hostedSession.cwd,
                ],
              },
      },
    };
    const handler = await readFile(
      path.join(repositoryRoot, "lib/mcp/request-handler.ts"),
      "utf-8",
    );
    const tools = [...registeredAutographToolNames(handler)];
    const marketplaceManifestPath = path.join(
      temporaryMarketplaceRoot,
      ".agents/plugins/marketplace.json",
    );
    await mkdir(path.dirname(marketplaceManifestPath), {
      mode: 0o700,
      recursive: true,
    });
    const marketplace = {
      interface: { displayName: "Autograph Development" },
      name: DEVELOPMENT_MARKETPLACE_NAME,
      plugins: [
        {
          category: "Developer Tools",
          name: DEVELOPMENT_PLUGIN_NAME,
          policy: {
            authentication: "ON_INSTALL",
            installation: "AVAILABLE",
          },
          source: {
            path: `./plugins/${DEVELOPMENT_PLUGIN_NAME}`,
            source: "local",
          },
        },
      ],
    };
    await Promise.all([
      writeFile(marketplaceManifestPath, `${JSON.stringify(marketplace, null, 2)}\n`, {
        mode: 0o600,
      }),
      writeFile(
        path.join(pluginRoot, PLUGIN_MANIFEST_PATH),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      ),
      writeFile(path.join(pluginRoot, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, {
        mode: 0o600,
      }),
      writeFile(path.join(pluginRoot, "tools-list.json"), `${JSON.stringify(tools, null, 2)}\n`, {
        mode: 0o600,
      }),
    ]);
    const receiptBase = {
      digest: sha256(
        JSON.stringify({
          endpoint,
          marketplace: DEVELOPMENT_MARKETPLACE_NAME,
          mcpServer,
          plugin: DEVELOPMENT_PLUGIN_NAME,
          selector: DEVELOPMENT_PLUGIN_SELECTOR,
          tools,
          version,
        }),
      ),
      endpoint,
      format: "autograph-development-package-v2",
      marketplace: DEVELOPMENT_MARKETPLACE_NAME,
      mcpAppPreview: false,
    } as const;
    const withHosted: typeof receiptBase & {
      hostedSessionResource?: string;
      execution?: "hosted";
    } = receiptBase;
    if (input.hostedSession !== undefined) {
      withHosted.hostedSessionResource = input.hostedSession.resourceUrl;
      withHosted.execution = "hosted";
    }
    const receipt = {
      ...withHosted,
      mcpServer,
      plugin: DEVELOPMENT_PLUGIN_NAME,
      publication: false,
      selector: DEVELOPMENT_PLUGIN_SELECTOR,
      tools,
      version,
    } as const;
    await writeFile(
      path.join(pluginRoot, "development-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rm(marketplaceRoot, { force: true, recursive: true });
    await rename(temporaryMarketplaceRoot, marketplaceRoot);
    return {
      marketplaceRoot,
      pluginRoot: path.join(marketplaceRoot, "plugins", DEVELOPMENT_PLUGIN_NAME),
      receipt,
    };
  } finally {
    await rm(temporaryMarketplaceRoot, { force: true, recursive: true });
  }
};

const disableGlobalDevelopmentPackage = async (codexHome: string) => {
  const configPath = path.join(codexHome, "config.toml");
  const config = await readFile(configPath, "utf-8");
  let inPlugin = false;
  let updated = false;
  const scoped = config
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("[")) {
        inPlugin = line.trim() === `[plugins."${DEVELOPMENT_PLUGIN_SELECTOR}"]`;
      }
      if (inPlugin && /^\s*enabled\s*=\s*(?<enabled>true|false)\s*$/u.test(line)) {
        updated = true;
        return "enabled = false";
      }
      return line;
    })
    .join("\n");
  if (!updated) {
    throw new Error("Codex did not write the development plugin enablement setting.");
  }
  await writeFile(configPath, scoped);
};

export const registerDevelopmentPackage = async (input: {
  codexBin?: string;
  codexHome?: string;
  installPlugin?: boolean;
  marketplaceRoot: string;
  version: string;
  runner?: DevelopmentCodexCommandRunner;
}) => {
  if (input.installPlugin === false) {
    return {
      marketplaceRoot: input.marketplaceRoot,
      selector: DEVELOPMENT_PLUGIN_SELECTOR,
      installed: false,
    };
  }
  if (input.codexBin === undefined || input.codexHome === undefined) {
    throw new Error("Plugin installation requires the Codex executable and profile root.");
  }
  const codexBin = path.resolve(input.codexBin);
  const codexHome = path.resolve(input.codexHome);
  const marketplaceRoot = path.resolve(input.marketplaceRoot);
  const runner: DevelopmentCodexCommandRunner =
    input.runner ??
    (async (args, options) => {
      try {
        const result = await execFileAsync(codexBin, [...args], {
          env: { ...process.env, CODEX_HOME: codexHome },
        });
        return { stderr: result.stderr, stdout: result.stdout };
      } catch (error) {
        if (options.allowFailure) {
          const failed = error as { stdout?: string; stderr?: string };
          return { stderr: failed.stderr ?? "", stdout: failed.stdout ?? "" };
        }
        throw error;
      }
    });
  await runner(["plugin", "remove", DEVELOPMENT_PLUGIN_SELECTOR, "--json"], {
    allowFailure: true,
  });
  await runner(["plugin", "marketplace", "remove", DEVELOPMENT_MARKETPLACE_NAME, "--json"], {
    allowFailure: true,
  });
  await runner(["plugin", "marketplace", "add", marketplaceRoot, "--json"], {});
  await runner(["plugin", "add", DEVELOPMENT_PLUGIN_SELECTOR, "--json"], {});
  await disableGlobalDevelopmentPackage(codexHome);
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
    installed.version !== input.version ||
    installed.installed !== true ||
    installed.source?.source !== "local" ||
    installed.source.path !== path.join(marketplaceRoot, "plugins", DEVELOPMENT_PLUGIN_NAME) ||
    installed.marketplaceSource?.sourceType !== "local" ||
    installed.marketplaceSource.source !== marketplaceRoot
  ) {
    throw new Error(
      `Codex did not report the exact project-scoped ${DEVELOPMENT_PLUGIN_SELECTOR} installation.`,
    );
  }
  return { marketplaceRoot, selector: DEVELOPMENT_PLUGIN_SELECTOR };
};

// `codex plugin add` writes this canonical table to the user config. Keep the
// installed package available, but let the repository config enable it.
export const developmentLaunchEnvironment = (input: {
  sourceRoot: string;
  snapshotRoot: string;
  destinationRoot: string;
  sourceSha: string;
  sourceTree: string;
  fingerprint: string;
  dependencyKey: string;
  evePort: number;
}): Readonly<Record<string, string>> => ({
  ...developmentExecutionEnvironment,
  APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY: input.dependencyKey,
  APP_BUILDER_DEVELOPMENT_SNAPSHOT_ROOT: input.snapshotRoot,
  APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: input.fingerprint,
  APP_BUILDER_DEVELOPMENT_SOURCE_ROOT: input.sourceRoot,
  APP_BUILDER_DEVELOPMENT_SOURCE_SHA: input.sourceSha,
  APP_BUILDER_DEVELOPMENT_SOURCE_TREE: input.sourceTree,
  EVE_AGENT_HOST: `http://127.0.0.1:${input.evePort}`,
  REPOSITORY_LOCAL_ROOTS: input.sourceRoot,
  REPOSITORY_WORKSPACE_ROOT: input.destinationRoot,
  WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "360000",
  WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: "360000",
});
