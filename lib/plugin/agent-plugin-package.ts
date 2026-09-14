import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { isMap, parseDocument } from "yaml";

import { isReservedPublicReleaseHostname } from "./public-release-endpoint.ts";
import { runSequentially } from "../async-sequential.ts";

const SPEC_VERSION = "1.0.0";
export const AUTOGRAPH_PACKAGE_VERSION = "0.2.12";
export const AUTOGRAPH_MCP_SERVER_NAME = "app-builder";
export const AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT = "http://127.0.0.1:3000/mcp";
const PLUGIN_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/plugin.schema.json`;
const MCP_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/mcp.schema.json`;
const SCHEMA_DIGESTS = {
  "mcp.schema.json": "d9904e6befac63b2bca19c32f3bc6a304173f5ed4f50daf8ce05fafc188c50ad",
  "plugin.schema.json": "fd74dfcbccea4a5b8768d9bc87b9da27449213ca5d464ace724ca48ec4bc074b",
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
const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HTTP_FIELD_VALUE = /^[\t\u0020-\u007E\u0080-\u00FF]*$/u;
const CREDENTIAL_HEADER =
  /(?:^|[-_])(?:authorization|cookie|credential|password|secret|token|api[-_]?key|private[-_]?key)(?:$|[-_])/iu;
const SECRET_LIKE_HEADER_VALUE =
  /(?:\$\{|\{\{|\}\}|(?:^|\s)(?:bearer|basic)\s|(?:api[-_ ]?key|secret|password|credential|private[-_ ]?key)\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)/iu;

type JsonObject = Record<string, unknown>;

const readJson = async (filePath: string): Promise<JsonObject> =>
  JSON.parse(await readFile(filePath, "utf-8")) as JsonObject;

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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

const schemaVersion = (schema: unknown) => {
  if (typeof schema !== "string") {
    return;
  }
  return schema.match(/\/schemas\/(?<version>[^/]+)\/(?:plugin|mcp)\.schema\.json$/u)?.[1];
};

export const assertAutographMcpEndpoint = (value: unknown, { release }: { release: boolean }) => {
  if (typeof value !== "string") {
    throw new TypeError(`${AUTOGRAPH_MCP_SERVER_NAME} must use an absolute MCP URL.`);
  }
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
  ) {
    throw new Error(
      `${path.relative(pluginRoot, skillPath)} field ${field} must be a string${
        min > 0 ? ` with at least ${min} character${min === 1 ? "" : "s"}` : ""
      }${max === undefined ? "" : ` and at most ${max} characters`}.`,
    );
  }
  return value;
};

const validateSkill = async (pluginRoot: string, skillDirectory: string) => {
  const skillPath = path.resolve(skillDirectory, "SKILL.md");
  await assertRegularFile(pluginRoot, skillPath);
  const contents = await readFile(skillPath, "utf-8");
  const match = contents.match(/^---[\t ]*\r?\n(?<frontmatter>[\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/u);
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
  const frontmatter = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
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
    value: frontmatter.name,
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
    value: frontmatter.description,
  });
  if ("license" in frontmatter) {
    requireString({
      field: "license",
      min: 1,
      pluginRoot,
      skillPath,
      value: frontmatter.license,
    });
  }
  if ("compatibility" in frontmatter) {
    requireString({
      field: "compatibility",
      max: 500,
      min: 1,
      pluginRoot,
      skillPath,
      value: frontmatter.compatibility,
    });
  }
  if ("allowed-tools" in frontmatter) {
    requireString({
      field: "allowed-tools",
      min: 1,
      pluginRoot,
      skillPath,
      value: frontmatter["allowed-tools"],
    });
  }
  if ("metadata" in frontmatter) {
    const { metadata } = frontmatter;
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Object.getPrototypeOf(metadata) !== Object.prototype ||
      Object.entries(metadata).some(
        ([key, value]) => typeof key !== "string" || typeof value !== "string",
      )
    ) {
      throw new Error(
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
  await assertRegularFile(resolvedPluginRoot, path.resolve(resolvedPluginRoot, "plugin.json"));
  await assertRegularFile(resolvedPluginRoot, path.resolve(resolvedPluginRoot, "mcp.json"));

  const schemaRoot = path.resolve(repositoryRoot, "schemas/agent-plugins", SPEC_VERSION);
  const schemaDocuments: Record<string, JsonObject> = {};
  for (const [name, digest] of Object.entries(SCHEMA_DIGESTS)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const bytes = await readFile(path.resolve(schemaRoot, name));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== digest) {
      throw new Error(`${name} does not match the pinned Agent Plugins ${SPEC_VERSION} schema.`);
    }
    schemaDocuments[name] = JSON.parse(bytes.toString("utf-8")) as JsonObject;
  }

  const plugin = await readJson(path.resolve(resolvedPluginRoot, "plugin.json"));
  const mcp = await readJson(path.resolve(resolvedPluginRoot, "mcp.json"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const [name, value, schema] of [
    ["plugin.json", plugin, schemaDocuments["plugin.schema.json"]],
    ["mcp.json", mcp, schemaDocuments["mcp.schema.json"]],
  ] as const) {
    const validate = ajv.compile(schema);
    if (!validate(value)) {
      throw new Error(`${name} is invalid: ${ajv.errorsText(validate.errors)}`);
    }
  }
  if (plugin.$schema !== PLUGIN_SCHEMA || mcp.$schema !== MCP_SCHEMA) {
    throw new Error(`Portable manifests must target Agent Plugins ${SPEC_VERSION}.`);
  }
  if (schemaVersion(plugin.$schema) !== schemaVersion(mcp.$schema)) {
    throw new Error("plugin.json and mcp.json must target the same Agent Plugins version.");
  }

  if (plugin.version !== AUTOGRAPH_PACKAGE_VERSION) {
    throw new Error(`plugin.json version must be exactly ${AUTOGRAPH_PACKAGE_VERSION}.`);
  }

  const servers = mcp.mcpServers as Record<string, JsonObject>;
  if (Object.keys(servers).length !== 1 || !Object.hasOwn(servers, AUTOGRAPH_MCP_SERVER_NAME)) {
    throw new Error(`mcp.json must declare exactly one ${AUTOGRAPH_MCP_SERVER_NAME} MCP server.`);
  }
  const server = servers[AUTOGRAPH_MCP_SERVER_NAME];
  if (server.type !== "streamable-http") {
    throw new Error(`${AUTOGRAPH_MCP_SERVER_NAME} must use the streamable-http transport.`);
  }
  assertAutographMcpEndpoint(server.url, { release });
  const headers = (server.headers ?? {}) as Record<string, string>;
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
    name: plugin.name as string,
    packageKind,
    specification: SPEC_VERSION,
    version: plugin.version as string,
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
