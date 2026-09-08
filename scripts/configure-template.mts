import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const originIndex = process.argv.indexOf("--origin");
const originValue =
  originIndex >= 0 ? process.argv[originIndex + 1] : undefined;
if (!originValue)
  throw new Error("Usage: pnpm configure --origin https://agent.example.com");
const origin = new URL(originValue);
if (origin.protocol !== "https:" || origin.pathname !== "/")
  throw new Error("Origin must be a literal HTTPS origin without a path.");

const path = resolve("mcp.json");
const manifest = JSON.parse(await readFile(path, "utf8"));
manifest.mcpServers["app-builder"].url = `${origin.origin}/mcp`;
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Configured MCP endpoint: ${origin.origin}/mcp`);
