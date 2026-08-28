import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex adapter", () => {
  it("binds the installed plugin to the local Eve MCP runtime", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(".codex-plugin/plugin.json"), "utf8"),
    );
    const mcp = JSON.parse(await readFile(resolve(".mcp.json"), "utf8"));
    const portableMcp = JSON.parse(await readFile(resolve("mcp.json"), "utf8"));

    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.apps).toBeUndefined();
    expect(mcp).toEqual({
      mcpServers: {
        "autograph-app-builder": {
          type: "http",
          url: "http://127.0.0.1:3000/mcp",
        },
      },
    });
    expect(portableMcp.mcpServers["autograph-app-builder"].url).toBe(
      "http://127.0.0.1:3000/mcp",
    );
    for (const prompt of manifest.interface.defaultPrompt) {
      expect(prompt.length).toBeLessThanOrEqual(128);
    }
  });

  it("fails closed instead of invoking another app builder", async () => {
    const skill = await readFile(resolve("skills/eve-agent/SKILL.md"), "utf8");

    for (const tool of [
      "eve_start",
      "eve_get",
      "eve_send",
      "eve_respond",
      "eve_cancel",
    ]) {
      expect(skill).toContain(`\`${tool}\``);
    }
    expect(skill).toContain("Do not invoke another app-building skill");
    expect(skill).toContain("edit the target repository directly");
    expect(skill).toContain("# Autograph App Builder orchestration");
    expect(skill).toContain("Never split one App Builder batch across calls");
    expect(skill).not.toContain("# Eve agent orchestration");
  });
});
