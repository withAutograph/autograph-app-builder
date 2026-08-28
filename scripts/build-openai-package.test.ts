import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runGenerator = (cwd: string, endpoint: string) =>
  new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        resolve("scripts/build-openai-package.mts"),
        "--endpoint",
        endpoint,
      ],
      { cwd, stdio: "ignore" },
    );
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : rejectRun(new Error(`OpenAI package generator exited ${code}.`)),
    );
  });

describe("OpenAI package generator", () => {
  it("binds both the Agent Plugins manifest and Codex adapter to the endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "autograph-openai-package-"));
    try {
      await writeFile(
        join(root, "plugin.json"),
        JSON.stringify({
          name: "autograph-app-builder",
          version: "0.1.0",
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
            "autograph-app-builder": {
              type: "streamable-http",
              url: "http://127.0.0.1:3000/mcp",
            },
          },
        }),
      );

      const endpoint = "https://preview.autograph.dev/mcp";
      await runGenerator(root, endpoint);

      const portable = JSON.parse(
        await readFile(join(root, "mcp.json"), "utf8"),
      );
      const codex = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
      const manifest = JSON.parse(
        await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"),
      );
      expect(portable.mcpServers["autograph-app-builder"].url).toBe(endpoint);
      expect(codex.mcpServers["autograph-app-builder"].url).toBe(endpoint);
      expect(manifest.interface).toMatchObject({
        displayName: "Autograph App Builder",
        shortDescription: "Design and build supported apps",
        longDescription:
          "Use Autograph App Builder to design, plan, create, validate, and separately publish apps in supported repositories.",
      });
      expect(manifest.interface.defaultPrompt).toHaveLength(3);
      for (const prompt of manifest.interface.defaultPrompt) {
        expect(prompt).toContain("Autograph App Builder");
        expect(prompt.length).toBeLessThanOrEqual(128);
      }
      expect(manifest.interface.defaultPrompt.join(" ")).toContain("eve_start");
      expect(manifest.interface.defaultPrompt.join(" ")).toContain(
        "Continue my app build with Autograph App Builder",
      );
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
});
