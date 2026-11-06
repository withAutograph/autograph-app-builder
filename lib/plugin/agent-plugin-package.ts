import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";
import { isMap, parseDocument } from "yaml";
import packageManifest from "../../package.json" with { type: "json" };

import { isReservedPublicReleaseHostname } from "./public-release-endpoint.ts";
import { runSequentially } from "../async-sequential.ts";

const SPEC_VERSION = "1.0.0";
export const AUTOGRAPH_PACKAGE_VERSION = packageManifest.version;
export const AUTOGRAPH_MCP_SERVER_NAME = "app-builder";
export const AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT = "http://127.0.0.1:3000/mcp";
const PLUGIN_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/plugin.schema.json`;
const MCP_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/mcp.schema.json`;
const SCHEMA_DIGESTS = {
  "mcp.schema.json": "d9904e6befac63b2bca19c32f3bc6a304173f5ed4f50daf8ce05fafc188c50ad",
  "plugin.schema.json": "fd74dfcbccea4a5b8768d9bc87b9da27449213ca5d464ace724ca48ec4bc074b",
} as const;
const PORTABLE_ENTRIES = ["plugin.json", "mcp.json", "skills", "LICENSE"] as const;
const PORTABLE_ENTRY_SET = new Set(PORTABLE_ENTRIES);
const SKILL_FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HTTP_FIELD_VALUE = /^[\t\u0020-\u007E\u0080-\u00FF]*$/u;
const CREDENTIAL_HEADER =
  /(?:^|[-_])(?:authorization|cookie|credential|password|secret|token|api[-_]?key|private[-_]?key)(?:$|[-_])/iu;
const SECRET_LIKE_HEADER_VALUE =
  /(?:\$\{|\{\{|\}\}|(?:^|\s)(?:bearer|basic)\s|(?:api[-_ ]?key|secret|password|credential|private[-_ ]?key)\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)/iu;
const MCP_SCHEMA_FILENAME = "mcp.schema.json";
const PLUGIN_JSON_FILENAME = "plugin.json";
const MCP_JSON_FILENAME = "mcp.json";
const MCP_MANIFEST_INVALID = "mcp.json is invalid: ";
const MANIFEST_PAIR = "plugin.json and mcp.json";
const INVALID_VALUE_MESSAGE = "must be a string.";

interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null;
type PluginManifest = JsonObject & {
  $schema: string;
  name: string;
  version?: string;
};
type McpServer = JsonObject & {
  type: string;
  url?: string;
  headers?: Record<string, string>;
};
type McpManifest = JsonObject & {
  $schema: string;
  mcpServers: Record<string, McpServer>;
};
const parsePluginManifest = (value: JsonObject): PluginManifest => ({
  ...value,
  $schema: String(value.$schema),
  name: String(value.name),
  version: value.version === undefined ? undefined : String(value.version),
});
const parseMcpManifest = (value: JsonObject): McpManifest => {
  const servers = value.mcpServers;
  if (servers === null || Array.isArray(servers) || typeof servers !== "object") {
    throw new TypeError("mcpServers must be an object.");
  }
  return {
    ...value,
    $schema: String(value.$schema),
    mcpServers: servers as Record<string, McpServer>,
  };
};
const YAML_MAPPING_ERROR = "frontmatter must be a valid YAML mapping.";
const skillFrontmatterSchema = z.record(
  z.string(),
  z.union([z.string(), z.record(z.string(), z.string())]),
);
type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
const parseSkillFrontmatter = (document: ReturnType<typeof parseDocument>) => {
  try {
    return skillFrontmatterSchema.parse(document.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new TypeError(YAML_MAPPING_ERROR, { cause: error });
    }
    throw error;
  }
};
const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isJsonValue)
  );
};

const parseJson = (contents: string): JsonValue => {
  const value: unknown = JSON.parse(contents);
  if (!isJsonValue(value)) {
    throw new TypeError("JSON document contains an unsupported value.");
  }
  return value;
};

const parseJsonObject = (contents: string): JsonObject => {
  const value = parseJson(contents);
  if (value === null || Array.isArray(value)) {
    throw new TypeError("JSON document must be an object.");
  }
  const object: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      value: entry,
      writable: true,
    });
  }
  return object;
};

const readJson = async (filePath: string): Promise<JsonObject> =>
  parseJsonObject(await readFile(filePath, "utf-8"));

const isMissingPath = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }
  return Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT";
};

const isWithin = (root: string, candidate: string) => {
  const candidatePath = path.relative(root, candidate);
  return (
    candidatePath === "" || (!candidatePath.startsWith(`..${path.sep}`) && candidatePath !== "..")
  );
};

const assertRegularFile = async (root: string, target: string) => {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${path.relative(root, target)} must be a regular file.`);
  }
  if (!isWithin(root, await realpath(target))) {
    throw new Error(`${path.relative(root, target)} escapes the plugin root.`);
  }
};

const assertDirectory = async (root: string, target: string) => {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${path.relative(root, target)} must be a directory.`);
  }
  if (!isWithin(root, await realpath(target))) {
    throw new Error(`${path.relative(root, target)} escapes the plugin root.`);
  }
};

const assertTreeContainsNoLinks = async (root: string, target: string) => {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`${path.relative(root, target)} must not be a symbolic link.`);
  }
  if (stat.isFile()) {
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`${path.relative(root, target)} must be a regular file or directory.`);
  }
  await runSequentially(await readdir(target), async (entry) => {
    await assertTreeContainsNoLinks(root, path.resolve(target, entry));
  });
};

const prepareSafeOutputParent = async (root: string, output: string) => {
  let current = root;
  for (const part of path.relative(root, output).split(path.sep).slice(0, -1)) {
    current = path.resolve(current, part);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`${path.relative(root, current)} must be a real directory.`);
      }
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await mkdir(current);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    if (!isWithin(root, await realpath(current))) {
      throw new Error(`${path.relative(root, current)} escapes the repository root.`);
    }
  }
  try {
    await assertTreeContainsNoLinks(root, output);
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }
};

const schemaVersion = (schema: string) =>
  /\/schemas\/(?<version>[^/]+)\/(?:plugin|mcp)\.schema\.json$/u.exec(schema)?.[1];

const requireServerUrl = (value: JsonValue | undefined): string => {
  if (typeof value === "string") {
    return value;
  }
  throw new TypeError(`${AUTOGRAPH_MCP_SERVER_NAME} must use the streamable-http transport.`);
};

export const assertAutographMcpEndpoint = (value: string, { release }: { release: boolean }) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${AUTOGRAPH_MCP_SERVER_NAME} must use an absolute MCP URL.`);
  }
  if (url.username || url.password || value.includes("?") || value.includes("#")) {
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} URL must not contain credentials, a query, or a fragment.`,
    );
  }
  if (url.pathname !== "/mcp") {
    throw new Error(`${AUTOGRAPH_MCP_SERVER_NAME} URL pathname must be exactly /mcp.`);
  }
  if (url.hostname.endsWith(".")) {
    throw new Error(`${AUTOGRAPH_MCP_SERVER_NAME} URL hostname must not end with a DNS root dot.`);
  }
  if (release) {
    if (url.protocol !== "https:" || isReservedPublicReleaseHostname(url.hostname)) {
      throw new Error(
        `${AUTOGRAPH_MCP_SERVER_NAME} must use a deployed HTTPS endpoint for release.`,
      );
    }
  } else if (url.protocol !== "https:" && value !== AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT) {
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} must use credential-free HTTPS or the fixed development endpoint.`,
    );
  }
  if (value !== `${url.origin}/mcp`) {
    throw new Error(
      `${AUTOGRAPH_MCP_SERVER_NAME} URL must use the exact canonical ${url.origin}/mcp form.`,
    );
  }
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
  value: string;
  field: string;
  skillPath: string;
  pluginRoot: string;
  min?: number;
  max?: number;
}) => {
  if (value.length < min || (max !== undefined && value.length > max)) {
    const minimum = min > 0 ? ` with at least ${min} characters` : "";
    const maximum = max === undefined ? "" : ` and at most ${max} characters`;
    const description = `field ${field} must be a string${minimum}${maximum}.`;
    throw new Error(`${path.relative(pluginRoot, skillPath)} ${description}`);
  }
  return value;
};

const requireFrontmatterString = (
  value: SkillFrontmatterValue | undefined,
  field: string,
  pluginRoot: string,
  skillPath: string,
): string => {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(
    `${path.relative(pluginRoot, skillPath)} field ${field} ${INVALID_VALUE_MESSAGE}`,
  );
};

const validateSkill = async (pluginRoot: string, skillDirectory: string) => {
  const skillPath = path.resolve(skillDirectory, "SKILL.md");
  await assertRegularFile(pluginRoot, skillPath);
  const contents = await readFile(skillPath, "utf-8");
  const match = /^---[\t ]*\r?\n(?<frontmatter>[\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/u.exec(contents);
  if (!match) {
    throw new Error(`${path.relative(pluginRoot, skillPath)} has invalid frontmatter.`);
  }
  const document = parseDocument(match[1], {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new Error(
      `${path.relative(pluginRoot, skillPath)} frontmatter must be a valid YAML mapping: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  const frontmatter = parseSkillFrontmatter(document);
  const unknownFields = Object.keys(frontmatter).filter(
    (field) => !SKILL_FRONTMATTER_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `${path.relative(pluginRoot, skillPath)} has unsupported frontmatter fields: ${unknownFields.join(", ")}.`,
    );
  }
  const name = requireString({
    field: "name",
    max: 64,
    min: 1,
    pluginRoot,
    skillPath,
    value: requireFrontmatterString(frontmatter.name, "name", pluginRoot, skillPath),
  });
  if (!/^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)) {
    throw new Error(`${path.relative(pluginRoot, skillPath)} has an invalid skill name.`);
  }
  if (name !== path.basename(skillDirectory)) {
    throw new Error(`${path.relative(pluginRoot, skillPath)} name must match its directory.`);
  }
  requireString({
    field: "description",
    max: 1024,
    min: 1,
    pluginRoot,
    skillPath,
    value: requireFrontmatterString(frontmatter.description, "description", pluginRoot, skillPath),
  });
  if ("license" in frontmatter) {
    requireString({
      field: "license",
      min: 1,
      pluginRoot,
      skillPath,
      value: requireFrontmatterString(frontmatter.license, "license", pluginRoot, skillPath),
    });
  }
  if ("compatibility" in frontmatter) {
    requireString({
      field: "compatibility",
      max: 500,
      min: 1,
      pluginRoot,
      skillPath,
      value: requireFrontmatterString(
        frontmatter.compatibility,
        "compatibility",
        pluginRoot,
        skillPath,
      ),
    });
  }
  if ("allowed-tools" in frontmatter) {
    requireString({
      field: "allowed-tools",
      min: 1,
      pluginRoot,
      skillPath,
      value: requireFrontmatterString(
        frontmatter["allowed-tools"],
        "allowed-tools",
        pluginRoot,
        skillPath,
      ),
    });
  }
  if ("metadata" in frontmatter) {
    const { metadata } = frontmatter;
    if (typeof metadata === "string") {
      throw new TypeError(
        `${path.relative(pluginRoot, skillPath)} field metadata must map string keys to string values.`,
      );
    }
  }
};

const validateHeaders = (serverName: string, headers: Record<string, string>) => {
  const normalizedNames = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!HTTP_FIELD_NAME.test(name)) {
      throw new Error(`${serverName} has an invalid HTTP header name: ${name}.`);
    }
    const normalized = name.toLowerCase();
    if (normalizedNames.has(normalized)) {
      throw new Error(`${serverName} repeats HTTP header ${name} with different casing.`);
    }
    normalizedNames.add(normalized);
    if (!HTTP_FIELD_VALUE.test(value)) {
      throw new Error(`${serverName} header ${name} has an invalid value.`);
    }
    if (CREDENTIAL_HEADER.test(name) || SECRET_LIKE_HEADER_VALUE.test(value)) {
      throw new Error(
        `${serverName} header ${name} is not demonstrably public declarative package data.`,
      );
    }
  }
};

const assertCleanGeneratedArtifact = async (pluginRoot: string) => {
  const entries = await readdir(pluginRoot);
  const unexpected = entries.filter((entry) => !PORTABLE_ENTRY_SET.has(entry));
  const missing = PORTABLE_ENTRIES.filter((entry) => !entries.includes(entry));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `Generated Agent Plugin artifact must contain exactly ${PORTABLE_ENTRIES.join(
        ", ",
      )}; unexpected: ${unexpected.join(", ") || "none"}; missing: ${
        missing.join(", ") || "none"
      }.`,
    );
  }
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
  const requestedPluginRoot = path.resolve(pluginRoot);
  const rootStat = await lstat(requestedPluginRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The plugin root must be a real directory.");
  }
  const resolvedPluginRoot = await realpath(requestedPluginRoot);
  await assertDirectory(resolvedPluginRoot, resolvedPluginRoot);
  if (packageKind === "generated-artifact") {
    await assertCleanGeneratedArtifact(resolvedPluginRoot);
  }
  await assertRegularFile(
    resolvedPluginRoot,
    path.resolve(resolvedPluginRoot, PLUGIN_JSON_FILENAME),
  );
  await assertRegularFile(resolvedPluginRoot, path.resolve(resolvedPluginRoot, MCP_JSON_FILENAME));

  const schemaRoot = path.resolve(repositoryRoot, "schemas/agent-plugins", SPEC_VERSION);
  const schemaEntries: PinnedSchemaEntry[] = [
    { digest: SCHEMA_DIGESTS[MCP_SCHEMA_FILENAME], name: MCP_SCHEMA_FILENAME },
    { digest: SCHEMA_DIGESTS["plugin.schema.json"], name: "plugin.schema.json" },
  ];
  const schemaBytes = await Promise.all(
    schemaEntries.map(async ({ name, digest }) => {
      const bytes = await readFile(path.resolve(schemaRoot, name));
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== digest) {
        throw new Error(`${name} does not match the pinned Agent Plugins ${SPEC_VERSION} schema.`);
      }
      return { name, schema: parseJsonObject(bytes.toString("utf-8")) };
    }),
  );
  const mcpSchemaDocument = schemaBytes.find(({ name }) => name === MCP_SCHEMA_FILENAME)?.schema;
  const pluginSchemaDocument = schemaBytes.find(
    ({ name }) => name === "plugin.schema.json",
  )?.schema;
  if (!mcpSchemaDocument || !pluginSchemaDocument) {
    throw new Error("Pinned Agent Plugins schemas are missing.");
  }

  const [pluginPayload, mcpPayload] = await Promise.all([
    readJson(path.resolve(resolvedPluginRoot, PLUGIN_JSON_FILENAME)),
    readJson(path.resolve(resolvedPluginRoot, MCP_JSON_FILENAME)),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validatePlugin = ajv.compile(pluginSchemaDocument);
  if (!validatePlugin(pluginPayload)) {
    throw new Error(`${PLUGIN_JSON_FILENAME} failed schema validation.`);
  }
  const validateMcp = ajv.compile(mcpSchemaDocument);
  if (!validateMcp(mcpPayload)) {
    throw new Error(`${MCP_MANIFEST_INVALID}schema validation failed.`);
  }
  const plugin = parsePluginManifest(pluginPayload);
  const mcp = parseMcpManifest(mcpPayload);
  if (plugin.$schema !== PLUGIN_SCHEMA || mcp.$schema !== MCP_SCHEMA) {
    throw new Error(`Portable manifests must target Agent Plugins ${SPEC_VERSION}.`);
  }
  if (schemaVersion(plugin.$schema) !== schemaVersion(mcp.$schema)) {
    throw new Error(`${MANIFEST_PAIR} must target the same Agent Plugins version.`);
  }

  if (plugin.version !== AUTOGRAPH_PACKAGE_VERSION) {
    throw new Error(`plugin.json version must be exactly ${AUTOGRAPH_PACKAGE_VERSION}.`);
  }

  const servers = mcp.mcpServers;
  if (Object.keys(servers).length !== 1 || !Object.hasOwn(servers, AUTOGRAPH_MCP_SERVER_NAME)) {
    throw new Error(`mcp.json must declare exactly one ${AUTOGRAPH_MCP_SERVER_NAME} MCP server.`);
  }
  const server = servers[AUTOGRAPH_MCP_SERVER_NAME];
  if (server.type !== "streamable-http") {
    throw new Error(`${AUTOGRAPH_MCP_SERVER_NAME} must use the streamable-http transport.`);
  }
  const serverUrl = requireServerUrl(server.url);
  assertAutographMcpEndpoint(serverUrl, { release });
  const headers = server.headers ?? {};
  validateHeaders(AUTOGRAPH_MCP_SERVER_NAME, headers);

  const skillsRoot = path.resolve(resolvedPluginRoot, "skills");
  await assertDirectory(resolvedPluginRoot, skillsRoot);
  await runSequentially(await readdir(skillsRoot, { withFileTypes: true }), async (entry) => {
    if (entry.isDirectory()) {
      await validateSkill(resolvedPluginRoot, path.resolve(skillsRoot, entry.name));
    }
  });
  await runSequentially(PORTABLE_ENTRIES, async (entry) => {
    await assertTreeContainsNoLinks(resolvedPluginRoot, path.resolve(resolvedPluginRoot, entry));
  });
  return {
    name: plugin.name,
    packageKind,
    specification: SPEC_VERSION,
    version: plugin.version,
  };
};

export const buildAgentPluginPackage = async ({
  repositoryRoot,
  outputRoot,
}: {
  repositoryRoot: string;
  outputRoot: string;
}) => {
  const requestedSource = path.resolve(repositoryRoot);
  const sourceStat = await lstat(requestedSource);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("The repository root must be a real directory.");
  }
  const source = await realpath(requestedSource);
  const requestedOutput = path.resolve(outputRoot);
  if (!isWithin(requestedSource, requestedOutput)) {
    throw new Error("Agent Plugin output must remain inside the repository root.");
  }
  const output = path.resolve(source, path.relative(requestedSource, requestedOutput));
  const artifactRoot = path.resolve(source, ".artifacts", "agent-plugin");
  if (!isWithin(artifactRoot, output) || output === artifactRoot) {
    throw new Error(
      "Agent Plugin output must be a named directory under .artifacts/agent-plugin/.",
    );
  }
  await runSequentially(PORTABLE_ENTRIES, async (entry) => {
    await assertTreeContainsNoLinks(source, path.resolve(source, entry));
  });
  await prepareSafeOutputParent(source, output);
  await rm(output, { force: true, recursive: true });
  await mkdir(output, { recursive: true });
  await runSequentially(PORTABLE_ENTRIES, async (entry) => {
    await cp(path.resolve(source, entry), path.resolve(output, entry), {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  });
  return output;
};
