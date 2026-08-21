import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { format } from "prettier";

const portable = JSON.parse(await readFile(resolve("plugin.json"), "utf8"));
const connectionIndex = process.argv.indexOf("--connection-id");
const connectionId =
  connectionIndex >= 0 ? process.argv[connectionIndex + 1] : undefined;
const manifest = {
  name: portable.name,
  version: portable.version,
  description: portable.description,
  author: portable.author,
  homepage: portable.homepage,
  repository: portable.repository,
  license: portable.license,
  keywords: portable.keywords,
  skills: "./skills/",
  apps: "./.app.json",
  interface: {
    displayName: "Autograph App Builder",
    shortDescription: "Design and create supported Autograph apps",
    longDescription:
      "Use a durable Eve agent to design, plan, create, validate, and separately publish apps in supported repositories.",
    developerName: portable.author.name,
    category: "Developer Tools",
    capabilities: ["Interactive", "Read", "Write"],
    websiteURL: portable.homepage,
    defaultPrompt: [
      "Design a new app with me.",
      "Create an app in a supported repository.",
      "Continue my app-building session.",
    ],
    brandColor: "#111827",
    screenshots: [],
  },
};
const apps = connectionId
  ? { apps: { "eve-agent": { id: connectionId } } }
  : { apps: {} };
await mkdir(resolve(".codex-plugin"), { recursive: true });
await writeFile(
  resolve(".codex-plugin/plugin.json"),
  await format(JSON.stringify(manifest), { parser: "json" }),
);
await writeFile(
  resolve(".app.json"),
  await format(JSON.stringify(apps), { parser: "json" }),
);
console.log(
  connectionId
    ? "Generated the OpenAI adapter with its registered MCP connection."
    : "Generated the skill-only OpenAI adapter; pass --connection-id after registering MCP.",
);
