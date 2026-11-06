import { developmentExecutionEnvironment } from "./execution-environment.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registeredAutographToolNames, sha256 } from "../../scripts/portable-release";

const LOCAL_SOURCE = "local";
const PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json";
const LOOPBACK_ORIGIN = "http://127.0.0.1:";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export const DEVELOPMENT_MARKETPLACE_NAME = "autograph-dev";
export const DEVELOPMENT_PLUGIN_NAME = "app-builder";
export const DEVELOPMENT_PLUGIN_SELECTOR = `${DEVELOPMENT_PLUGIN_NAME}@${DEVELOPMENT_MARKETPLACE_NAME}`;
export const DEVELOPMENT_MCP_SERVER_NAME = "app-builder-dev";
export const DEVELOPMENT_VERSION = "0.0.0-development";

interface JsonObject {
  [key: string]: JsonValue;
}

type PluginManifest = JsonObject;
type InstalledPlugin = JsonObject;
const STDOUT_FIELD = "stdout";
const STDERR_FIELD = "stderr";

const execFileAsync: (
  file: string,
  args: string[],
  options: { encoding: BufferEncoding; env: NodeJS.ProcessEnv },
) => Promise<{ stderr: string; stdout: string }> = promisify(
  // SAFETY: execFile's promisify overload reports its ChildProcess return type, but the callback
  // form completes through the callback and promisify returns stdout and stderr as strings here.
  execFile as (
    file: string,
    args: string[],
    options: { encoding: BufferEncoding; env: NodeJS.ProcessEnv },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void,
);

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isObjectField = (value: JsonObject, key: string): boolean => isObject(value[key]);

const getObjectField = (value: JsonObject, key: string): JsonObject => {
  const field = value[key];
  if (!isObject(field)) {
    throw new Error(`Expected object field ${key}.`);
  }
  return field;
};

const parseCommandError = (error: Error): { stderr: string; stdout: string } | undefined => {
  const value: unknown = error;
  if (!isObject(value)) return undefined;
  const stdout = value[STDOUT_FIELD];
  const stderr = value[STDERR_FIELD];
  const output = stdout === null || stdout === undefined ? "" : JSON.stringify(stdout);
  const errorOutput = stderr === null || stderr === undefined ? "" : JSON.stringify(stderr);
  return { stderr: errorOutput, stdout: output };
};

const parseInstalledPlugins = (source: string): InstalledPlugin[] => {
  const value: unknown = JSON.parse(source);
  if (!isObject(value) || !Array.isArray(value.installed)) {
    return [];
  }
  return value.installed.filter(isObject);
};

const isExactDevelopmentInstallation = (
  output: string,
  version: string,
  marketplaceRoot: string,
): boolean => {
  const plugins = parseInstalledPlugins(output);
  if (plugins.length !== 1) {
    return false;
  }
  const [plugin] = plugins;
  if (
    plugin === undefined ||
    !isObjectField(plugin, "source") ||
    !isObjectField(plugin, "marketplaceSource")
  ) {
    return false;
  }
  const { pluginId, name, marketplaceName, installed } = plugin;
  const { version: installedVersion } = plugin;
  const source = getObjectField(plugin, "source");
  const marketplaceSource = getObjectField(plugin, "marketplaceSource");
  if (pluginId !== DEVELOPMENT_PLUGIN_SELECTOR || name !== DEVELOPMENT_PLUGIN_NAME) return false;
  if (marketplaceName !== DEVELOPMENT_MARKETPLACE_NAME || installedVersion !== version)
    return false;
  if (
    installed !== true ||
    source.source !== LOCAL_SOURCE ||
    marketplaceSource.sourceType !== LOCAL_SOURCE
  )
    return false;
  return (
    source.path === path.join(marketplaceRoot, "plugins", DEVELOPMENT_PLUGIN_NAME) &&
    marketplaceSource.source === marketplaceRoot
  );
};

const parsePluginManifest = (source: string): PluginManifest => {
  const value: unknown = JSON.parse(source);
  if (!isObject(value)) {
    throw new Error("Development plugin manifest must be a JSON object.");
  }
  return value;
};

const developmentVersion = (port: number, hosted = false): string =>
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
          return [entry.name, await packageInputDigest(entryPath)];
        }
        if (!entry.isFile()) {
          throw new Error(`Development package input was not a regular file: ${entryPath}`);
        }
        return [entry.name, sha256(await readFile(entryPath))];
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
      hostedSession: input.hostedSession,
      icon: sha256(await readFile(path.join(repositoryRoot, "assets", "autograph-icon.png"))),
      mcpHandler: sha256(await readFile(path.join(repositoryRoot, "lib/mcp/request-handler.ts"))),
      origin: input.origin,
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
  const origin = input.origin ?? `${LOOPBACK_ORIGIN}${input.port}`;
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
    await cp(
      path.join(repositoryRoot, "assets/autograph-icon.png"),
      path.join(pluginRoot, "assets/autograph-icon.png"),
    );
    const sourceManifest = parsePluginManifest(
      await readFile(path.join(repositoryRoot, PLUGIN_MANIFEST_PATH), "utf-8"),
    );
    const sourceInterface = isObject(sourceManifest.interface) ? sourceManifest.interface : {};
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
    const cleanManifest = { ...manifest };
    delete cleanManifest.apps;
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
                command: input.hostedSession.nodeBin,
                type: "stdio",
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
            source: LOCAL_SOURCE,
          },
        },
      ],
    };
    await Promise.all([
      writeFile(marketplaceManifestPath, `${JSON.stringify(marketplace, null, 2)}\n`, {
        mode: 0o600,
      }),
      writeFile(
        path.join(pluginRoot, ".codex-plugin/plugin.json"),
        `${JSON.stringify(cleanManifest, null, 2)}\n`,
        { mode: 0o600 },
      ),
      writeFile(path.join(pluginRoot, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, {
        mode: 0o600,
      }),
      writeFile(path.join(pluginRoot, "tools-list.json"), `${JSON.stringify(tools, null, 2)}\n`, {
        mode: 0o600,
      }),
    ]);
    const receipt = {
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
      mcpServer,
      plugin: DEVELOPMENT_PLUGIN_NAME,
      publication: false,
      selector: DEVELOPMENT_PLUGIN_SELECTOR,
      tools,
      version,
    };
    if (input.hostedSession !== undefined) {
      Object.assign(receipt, {
        execution: "hosted",
        hostedSessionResource: input.hostedSession.resourceUrl,
      });
    }
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
      installed: false,
      marketplaceRoot: input.marketplaceRoot,
      selector: DEVELOPMENT_PLUGIN_SELECTOR,
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
          encoding: "utf-8",
          env: { ...process.env, CODEX_HOME: codexHome },
        });
        return { stderr: result.stderr, stdout: result.stdout };
      } catch (error) {
        if (options.allowFailure === true) {
          if (error instanceof Error) {
            const commandOutput = parseCommandError(error);
            if (commandOutput !== undefined) return commandOutput;
          }
          throw error;
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
  if (!isExactDevelopmentInstallation(listed.stdout, input.version, marketplaceRoot)) {
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
}) => {
  const environment = {
    ...developmentExecutionEnvironment,
    APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY: input.dependencyKey,
    APP_BUILDER_DEVELOPMENT_SNAPSHOT_ROOT: input.snapshotRoot,
    APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: input.fingerprint,
    APP_BUILDER_DEVELOPMENT_SOURCE_ROOT: input.sourceRoot,
    APP_BUILDER_DEVELOPMENT_SOURCE_SHA: input.sourceSha,
    APP_BUILDER_DEVELOPMENT_SOURCE_TREE: input.sourceTree,
    EVE_AGENT_HOST: `${LOOPBACK_ORIGIN}${input.evePort}`,
    REPOSITORY_LOCAL_ROOTS: input.sourceRoot,
    REPOSITORY_WORKSPACE_ROOT: input.destinationRoot,
    WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "360000",
    WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: "360000",
  };
  return environment satisfies Readonly<Record<string, string>>;
};
