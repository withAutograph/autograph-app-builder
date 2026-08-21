import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));
const [plugin, mcp, pluginSchema, mcpSchema] = await Promise.all([
  readJson(resolve("plugin.json")),
  readJson(resolve("mcp.json")),
  readJson(resolve("schemas/agent-plugins/1.0.0/plugin.schema.json")),
  readJson(resolve("schemas/agent-plugins/1.0.0/mcp.schema.json")),
]);
const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const [name, value, schema] of [
  ["plugin.json", plugin, pluginSchema],
  ["mcp.json", mcp, mcpSchema],
] as const) {
  const validate = ajv.compile(schema);
  if (!validate(value))
    throw new Error(`${name} is invalid: ${ajv.errorsText(validate.errors)}`);
}
const url = new URL(mcp.mcpServers["autograph-app-builder"].url);
if (url.protocol !== "https:" || url.username || url.password)
  throw new Error("The MCP URL must be credential-free HTTPS.");
if (
  process.argv.includes("--release") &&
  (url.hostname.endsWith(".invalid") || url.hostname === "localhost")
)
  throw new Error("Configure a production MCP URL before release validation.");
console.log("Portable Agent Plugin manifests are valid.");
