import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { isMap, parseDocument } from "yaml";

import { isReservedPublicReleaseHostname } from "./public-release-endpoint.ts";

const SPEC_VERSION = "1.0.0";
export const AUTOGRAPH_PACKAGE_VERSION = "0.2.3";
export const AUTOGRAPH_MCP_SERVER_NAME = "app-builder";
export const AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT = "http://127.0.0.1:3000/mcp";
const PLUGIN_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/plugin.schema.json`;
const MCP_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/mcp.schema.json`;
const SCHEMA_DIGESTS = {
  "plugin.schema.json":
    "fd74dfcbccea4a5b8768d9bc87b9da27449213ca5d464ace724ca48ec4bc074b",
  "mcp.schema.json":
    "d9904e6befac63b2bca19c32f3bc6a304173f5ed4f50daf8ce05fafc188c50ad",
} as const;
const PORTABLE_ENTRIES = ["plugin.json", "mcp.json", "skills", "LICENSE"];
const PORTABLE_ENTRY_SET = new Set(PORTABLE_ENTRIES);
const SKILL_FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const CREDENTIAL_HEADER =
  /(?:^|[-_])(?:authorization|cookie|credential|password|secret|token|api[-_]?key|private[-_]?key)(?:$|[-_])/i;
const SECRET_LIKE_HEADER_VALUE =
  /(?:\$\{|\{\{|\}\}|(?:^|\s)(?:bearer|basic)\s|(?:api[-_ ]?key|secret|password|credential|private[-_ ]?key)\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)/i;

type JsonObject = Record<string, unknown>;

const readJson = async (path: string): Promise<JsonObject> =>
  JSON.parse(await readFile(path, "utf8")) as JsonObject;

const isWithin = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const assertRegularFile = async (root: string, path: string) => {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${relative(root, path)} must be a regular file.`);
  if (!isWithin(root, await realpath(path)))
    throw new Error(`${relative(root, path)} escapes the plugin root.`);
};

const assertDirectory = async (root: string, path: string) => {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`${relative(root, path)} must be a directory.`);
  if (!isWithin(root, await realpath(path)))
    throw new Error(`${relative(root, path)} escapes the plugin root.`);
};

const assertTreeContainsNoLinks = async (root: string, path: string) => {
  const stat = await lstat(path);
  if (stat.isSymbolicLink())
    throw new Error(`${relative(root, path)} must not be a symbolic link.`);
  if (stat.isFile()) return;
  if (!stat.isDirectory())
    throw new Error(
      `${relative(root, path)} must be a regular file or directory.`,
    );
  for (const entry of await readdir(path))
    await assertTreeContainsNoLinks(root, resolve(path, entry));
};

const prepareSafeOutputParent = async (root: string, output: string) => {
  let current = root;
  for (const part of relative(root, output).split(sep).slice(0, -1)) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`${relative(root, current)} must be a real directory.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
    if (!isWithin(root, await realpath(current)))
      throw new Error(
        `${relative(root, current)} escapes the repository root.`,
      );
  }
  try {
    await assertTreeContainsNoLinks(root, output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const schemaVersion = (schema: unknown) => {
  if (typeof schema !== "string") return undefined;
  return schema.match(/\/schemas\/([^/]+)\/(?:plugin|mcp)\.schema\.json$/)?.[1];
};

export const assertAutographMcpEndpoint = (
  value: unknown,
  { release }: { release: boolean },
) => {
  if (typeof value !== "string")
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} must use an absolute MCP URL.`,
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} must use an absolute MCP URL.`,
    );
  }
  if (
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  )
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} URL must not contain credentials, a query, or a fragment.`,
    );
  if (url.pathname !== "/mcp")
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} URL pathname must be exactly /mcp.`,
    );
  if (url.hostname.endsWith("."))
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} URL hostname must not end with a DNS root dot.`,
    );
  if (release) {
    if (
      url.protocol !== "https:" ||
      isReservedPublicReleaseHostname(url.hostname)
    )
      throw new Error(
        `${AUTOGRAPH_MCP_SERVER_NAME} must use a deployed HTTPS endpoint for release.`,
      );
  } else if (
    url.protocol !== "https:" &&
    value !== AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT
  ) {
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} must use credential-free HTTPS or the fixed development endpoint.`,
    );
  }
  if (value !== `${url.origin}/mcp`)
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} URL must use the exact canonical ${url.origin}/mcp form.`,
    );
  return url;
};

const requireString = ({
  value,
  field,
  skillPath,
  pluginRoot,
  min = 0,
  max,
}: {
  value: unknown;
  field: string;
  skillPath: string;
  pluginRoot: string;
  min?: number;
  max?: number;
}) => {
  if (
    typeof value !== "string" ||
    value.length < min ||
    (max !== undefined && value.length > max)
  )
    throw new Error(
      `${relative(pluginRoot, skillPath)} field ${field} must be a string${
        min > 0 ? ` with at least ${min} character${min === 1 ? "" : "s"}` : ""
      }${max === undefined ? "" : ` and at most ${max} characters`}.`,
    );
  return value;
};

const validateSkill = async (pluginRoot: string, skillDirectory: string) => {
  const skillPath = resolve(skillDirectory, "SKILL.md");
  await assertRegularFile(pluginRoot, skillPath);
  const contents = await readFile(skillPath, "utf8");
  const match = contents.match(
    /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/,
  );
  if (!match)
    throw new Error(
      `${relative(pluginRoot, skillPath)} has invalid frontmatter.`,
    );
  const document = parseDocument(match[1], {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || !isMap(document.contents))
    throw new Error(
      `${relative(pluginRoot, skillPath)} frontmatter must be a valid YAML mapping: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  const frontmatter = document.toJS({ maxAliasCount: 0 }) as Record<
    string,
    unknown
  >;
  const unknownFields = Object.keys(frontmatter).filter(
    (field) => !SKILL_FRONTMATTER_FIELDS.has(field),
  );
  if (unknownFields.length > 0)
    throw new Error(
      `${relative(pluginRoot, skillPath)} has unsupported frontmatter fields: ${unknownFields.join(", ")}.`,
    );
  const name = requireString({
    value: frontmatter.name,
    field: "name",
    skillPath,
    pluginRoot,
    min: 1,
    max: 64,
  });
  if (!/^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name))
    throw new Error(
      `${relative(pluginRoot, skillPath)} has an invalid skill name.`,
    );
  if (name !== basename(skillDirectory))
    throw new Error(
      `${relative(pluginRoot, skillPath)} name must match its directory.`,
    );
  requireString({
    value: frontmatter.description,
    field: "description",
    skillPath,
    pluginRoot,
    min: 1,
    max: 1024,
  });
  if ("license" in frontmatter)
    requireString({
      value: frontmatter.license,
      field: "license",
      skillPath,
      pluginRoot,
      min: 1,
    });
  if ("compatibility" in frontmatter)
    requireString({
      value: frontmatter.compatibility,
      field: "compatibility",
      skillPath,
      pluginRoot,
      min: 1,
      max: 500,
    });
  if ("allowed-tools" in frontmatter)
    requireString({
      value: frontmatter["allowed-tools"],
      field: "allowed-tools",
      skillPath,
      pluginRoot,
      min: 1,
    });
  if ("metadata" in frontmatter) {
    const metadata = frontmatter.metadata;
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Object.getPrototypeOf(metadata) !== Object.prototype ||
      Object.entries(metadata).some(
        ([key, value]) => typeof key !== "string" || typeof value !== "string",
      )
    )
      throw new Error(
        `${relative(pluginRoot, skillPath)} field metadata must map string keys to string values.`,
      );
  }
};

const validateHeaders = (
  serverName: string,
  headers: Record<string, string>,
) => {
  const normalizedNames = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!HTTP_FIELD_NAME.test(name))
      throw new Error(
        `${serverName} has an invalid HTTP header name: ${name}.`,
      );
    const normalized = name.toLowerCase();
    if (normalizedNames.has(normalized))
      throw new Error(
        `${serverName} repeats HTTP header ${name} with different casing.`,
      );
    normalizedNames.add(normalized);
    if (!HTTP_FIELD_VALUE.test(value))
      throw new Error(`${serverName} header ${name} has an invalid value.`);
    if (CREDENTIAL_HEADER.test(name) || SECRET_LIKE_HEADER_VALUE.test(value))
      throw new Error(
        `${serverName} header ${name} is not demonstrably public declarative package data.`,
      );
  }
};

const assertCleanGeneratedArtifact = async (pluginRoot: string) => {
  const entries = await readdir(pluginRoot);
  const unexpected = entries.filter((entry) => !PORTABLE_ENTRY_SET.has(entry));
  const missing = PORTABLE_ENTRIES.filter((entry) => !entries.includes(entry));
  if (unexpected.length > 0 || missing.length > 0)
    throw new Error(
      `Generated Agent Plugin artifact must contain exactly ${PORTABLE_ENTRIES.join(
        ", ",
      )}; unexpected: ${unexpected.join(", ") || "none"}; missing: ${
        missing.join(", ") || "none"
      }.`,
    );
};

export const validateAgentPluginPackage = async ({
  pluginRoot,
  repositoryRoot,
  release = false,
  packageKind = "source",
}: {
  pluginRoot: string;
  repositoryRoot: string;
  release?: boolean;
  packageKind?: "source" | "generated-artifact";
}) => {
  const requestedPluginRoot = resolve(pluginRoot);
  const rootStat = await lstat(requestedPluginRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("The plugin root must be a real directory.");
  const resolvedPluginRoot = await realpath(requestedPluginRoot);
  await assertDirectory(resolvedPluginRoot, resolvedPluginRoot);
  if (packageKind === "generated-artifact")
    await assertCleanGeneratedArtifact(resolvedPluginRoot);
  await assertRegularFile(
    resolvedPluginRoot,
    resolve(resolvedPluginRoot, "plugin.json"),
  );
  await assertRegularFile(
    resolvedPluginRoot,
    resolve(resolvedPluginRoot, "mcp.json"),
  );

  const schemaRoot = resolve(
    repositoryRoot,
    "schemas/agent-plugins",
    SPEC_VERSION,
  );
  const schemaDocuments: Record<string, JsonObject> = {};
  for (const [name, digest] of Object.entries(SCHEMA_DIGESTS)) {
    const bytes = await readFile(resolve(schemaRoot, name));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== digest)
      throw new Error(
        `${name} does not match the pinned Agent Plugins ${SPEC_VERSION} schema.`,
      );
    schemaDocuments[name] = JSON.parse(bytes.toString("utf8")) as JsonObject;
  }

  const plugin = await readJson(resolve(resolvedPluginRoot, "plugin.json"));
  const mcp = await readJson(resolve(resolvedPluginRoot, "mcp.json"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const [name, value, schema] of [
    ["plugin.json", plugin, schemaDocuments["plugin.schema.json"]],
    ["mcp.json", mcp, schemaDocuments["mcp.schema.json"]],
  ] as const) {
    const validate = ajv.compile(schema);
    if (!validate(value))
      throw new Error(`${name} is invalid: ${ajv.errorsText(validate.errors)}`);
  }
  if (plugin.$schema !== PLUGIN_SCHEMA || mcp.$schema !== MCP_SCHEMA)
    throw new Error(
      `Portable manifests must target Agent Plugins ${SPEC_VERSION}.`,
    );
  if (schemaVersion(plugin.$schema) !== schemaVersion(mcp.$schema))
    throw new Error(
      "plugin.json and mcp.json must target the same Agent Plugins version.",
    );

  if (plugin.version !== AUTOGRAPH_PACKAGE_VERSION)
    throw new Error(
      `plugin.json version must be exactly ${AUTOGRAPH_PACKAGE_VERSION}.`,
    );

  const servers = mcp.mcpServers as Record<string, JsonObject>;
  if (
    Object.keys(servers).length !== 1 ||
    !Object.hasOwn(servers, AUTOGRAPH_MCP_SERVER_NAME)
  )
    throw new Error(
      `mcp.json must declare exactly one ${AUTOGRAPH_MCP_SERVER_NAME} MCP server.`,
    );
  const server = servers[AUTOGRAPH_MCP_SERVER_NAME];
  if (server.type !== "streamable-http")
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} must use the streamable-http transport.`,
    );
  assertAutographMcpEndpoint(server.url, { release });
  const headers = (server.headers ?? {}) as Record<string, string>;
  validateHeaders(AUTOGRAPH_MCP_SERVER_NAME, headers);

  const skillsRoot = resolve(resolvedPluginRoot, "skills");
  await assertDirectory(resolvedPluginRoot, skillsRoot);
  for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await validateSkill(resolvedPluginRoot, resolve(skillsRoot, entry.name));
  }
  for (const entry of PORTABLE_ENTRIES)
    await assertTreeContainsNoLinks(
      resolvedPluginRoot,
      resolve(resolvedPluginRoot, entry),
    );
  return {
    name: plugin.name as string,
    version: plugin.version as string,
    specification: SPEC_VERSION,
    packageKind,
  };
};

export const buildAgentPluginPackage = async ({
  repositoryRoot,
  outputRoot,
}: {
  repositoryRoot: string;
  outputRoot: string;
}) => {
  const requestedSource = resolve(repositoryRoot);
  const sourceStat = await lstat(requestedSource);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    throw new Error("The repository root must be a real directory.");
  const source = await realpath(requestedSource);
  const requestedOutput = resolve(outputRoot);
  if (!isWithin(requestedSource, requestedOutput))
    throw new Error(
      "Agent Plugin output must remain inside the repository root.",
    );
  const output = resolve(source, relative(requestedSource, requestedOutput));
  const artifactRoot = resolve(source, ".artifacts", "agent-plugin");
  if (!isWithin(artifactRoot, output) || output === artifactRoot)
    throw new Error(
      "Agent Plugin output must be a named directory under .artifacts/agent-plugin/.",
    );
  for (const entry of PORTABLE_ENTRIES)
    await assertTreeContainsNoLinks(source, resolve(source, entry));
  await prepareSafeOutputParent(source, output);
  await rm(output, { force: true, recursive: true });
  await mkdir(output, { recursive: true });
  for (const entry of PORTABLE_ENTRIES)
    await cp(resolve(source, entry), resolve(output, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  return output;
};
