import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runGenerator = (cwd: string, endpoint: string) =>
  new Promise<void>((resolveRun, rejectRun) => {
    let stderr = "";
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        resolve("scripts/build-openai-package.mts"),
        "--endpoint",
        endpoint,
      ],
      { cwd, stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : rejectRun(
            new Error(
              `OpenAI package generator exited ${code}: ${stderr.trim()}`,
            ),
          ),
    );
  });

const writeFixture = async (
  root: string,
  {
    version = "0.2.1",
    extraServer = false,
  }: { version?: string; extraServer?: boolean } = {},
) => {
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      name: "app-builder",
      version,
      description: "test",
      author: { name: "Autograph" },
      homepage: "https://github.com/withAutograph/autograph-app-builder",
      repository: "https://github.com/withAutograph/autograph-app-builder",
      license: "MIT",
      keywords: [],
    }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        "app-builder": {
          type: "streamable-http",
          url: "http://127.0.0.1:3000/mcp",
        },
        ...(extraServer
          ? {
              alternate: {
                type: "streamable-http",
                url: "https://preview.autograph.dev/alternate",
              },
            }
          : {}),
      },
    }),
  );
};

describe("OpenAI package generator", () => {
  it("binds both the Agent Plugins manifest and Codex adapter to the endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "autograph-openai-package-"));
    try {
      await writeFixture(root);

      const endpoint = "https://preview.autograph.dev/mcp";
      await runGenerator(root, endpoint);

      const portable = JSON.parse(
        await readFile(join(root, "mcp.json"), "utf8"),
      );
      const codex = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
      const manifest = JSON.parse(
        await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"),
      );
      expect(portable.mcpServers["app-builder"].url).toBe(endpoint);
      expect(Object.keys(portable.mcpServers)).toEqual(["app-builder"]);
      expect(codex.mcpServers["app-builder"].url).toBe(endpoint);
      expect(Object.keys(codex.mcpServers)).toEqual(["app-builder"]);
      expect(manifest.version).toBe("0.2.1");
      expect(manifest.interface).toMatchObject({
        displayName: "Autograph App Builder",
        shortDescription: "Design and create apps with Autograph",
        longDescription:
          "Use Autograph App Builder to design, plan, create, validate, and separately publish apps in explicitly supported repositories.",
        composerIcon: "./assets/autograph-icon.png",
        logo: "./assets/autograph-icon.png",
      });
      expect(manifest.interface.defaultPrompt).toHaveLength(3);
      for (const prompt of manifest.interface.defaultPrompt) {
        expect(prompt.length).toBeLessThanOrEqual(128);
      }
      expect(manifest.interface.defaultPrompt).toEqual([
        "Create an app for [who it is for, what they need to do, and the outcome you want]",
        "Build an event planning app for coordinating guests, schedules, and tasks",
        "Design a customer feedback app with a clear review workflow",
      ]);
      expect(manifest.interface.defaultPrompt.join(" ")).not.toContain(
        "App Builder session",
      );
      expect(manifest.interface.defaultPrompt.join(" ")).not.toContain(
        "through Eve",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a versioned MCP path", "https://preview.autograph.dev/mcp/v2"],
    ["an alternate MCP path", "https://preview.autograph.dev/api/mcp"],
    ["an MCP query", "https://preview.autograph.dev/mcp?tenant=public"],
    ["an MCP fragment", "https://preview.autograph.dev/mcp#tools"],
    ["URL credentials", "https://user:secret@preview.autograph.dev/mcp"],
    ["a trailing-dot localhost", "https://localhost./mcp"],
    ["a trailing-dot example host", "https://example.com./mcp"],
    ["a trailing-dot reserved suffix", "https://agent.invalid./mcp"],
    ["a trailing-dot localhost suffix", "https://agent.localhost./mcp"],
    ["a zero IPv4 alias", "https://0/mcp"],
    ["the unspecified IPv4 address", "https://0.0.0.0/mcp"],
    ["the unspecified IPv6 address", "https://[::]/mcp"],
    ["an IPv4-mapped unspecified address", "https://[::ffff:0:0]/mcp"],
    ["an IPv4-mapped loopback", "https://[::ffff:7f00:1]/mcp"],
    ["a noncanonical IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/mcp"],
    ["a raw dot-segment alias", "https://preview.autograph.dev/a/../mcp"],
    [
      "a percent-encoded dot-segment alias",
      "https://preview.autograph.dev/a/%2e%2e/mcp",
    ],
    ["a mixed-case hostname", "https://PREVIEW.autograph.dev/mcp"],
    ["an explicit default port", "https://preview.autograph.dev:443/mcp"],
  ])("rejects %s", async (_name, endpoint) => {
    const root = await mkdtemp(join(tmpdir(), "autograph-openai-package-"));
    try {
      await writeFixture(root);
      const originalMcp = await readFile(join(root, "mcp.json"));
      await expect(runGenerator(root, endpoint)).rejects.toThrow();
      expect(await readFile(join(root, "mcp.json"))).toEqual(originalMcp);
      await expect(readFile(join(root, ".mcp.json"))).rejects.toThrow();
      await expect(
        readFile(join(root, ".codex-plugin/plugin.json")),
      ).rejects.toThrow();
      await expect(readFile(join(root, ".app.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an extra MCP server route", async () => {
    const root = await mkdtemp(join(tmpdir(), "autograph-openai-package-"));
    try {
      await writeFixture(root, { extraServer: true });
      await expect(
        runGenerator(root, "https://preview.autograph.dev/mcp"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["0.1.0", "0.2.0", "1.0.0"])(
    "rejects package version %s",
    async (version) => {
      const root = await mkdtemp(join(tmpdir(), "autograph-openai-package-"));
      try {
        await writeFixture(root, { version });
        await expect(
          runGenerator(root, "https://preview.autograph.dev/mcp"),
        ).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
