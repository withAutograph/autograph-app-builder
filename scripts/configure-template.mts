import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const originIndex = process.argv.indexOf("--origin");
const originValue = originIndex === -1 ? undefined : process.argv[originIndex + 1];
if (!originValue) {
  throw new Error("Usage: pnpm configure --origin https://agent.example.com");
}
const origin = new URL(originValue);
if (origin.protocol !== "https:" || origin.pathname !== "/") {
  throw new Error("Origin must be a literal HTTPS origin without a path.");
}

const manifestPath = path.resolve("mcp.json");
// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing JSON parsing boundary.
const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
// oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
manifest.mcpServers["app-builder"].url = `${origin.origin}/mcp`;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Configured MCP endpoint: ${origin.origin}/mcp`);
